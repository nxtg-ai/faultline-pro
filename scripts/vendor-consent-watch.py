#!/usr/bin/env python3
"""vendor-consent-watch.py: alert on any reply from a search vendor Faultline Pro has written to.

Prereg amendment A1 (docs/research/2026-10-05-prereg-retrieval-provider-comparison-v1.md)
suspends the Ceramic and Exa arms until each vendor answers the consent request in
docs/research/2026-10-05-search-vendor-consent-drafts.md. EMMA-SOUL's ruling
(al:f24b3825e397565d) asks for a watch that catches ANY reply, a decline as much as a
yes. So this matches every message from a watched domain, not only a positive one.

engage@nxtg.ai delivers into the Zoho INBOX this reads (probed 2026-10-05). Zoho files some mail
into other folders: Google Cloud billing alerts land in "Notification" (both positive controls,
2026-10-13 and 2026-11-01, sat there unseen), so every folder in WATCH_FOLDERS is read.
Read-only on the mailbox (readonly select, BODY.PEEK, headers only). The credentials
come from ~/.secrets/geo-stripe.env and are never printed. Each message alerts once:
seen UIDs are kept in the state file.

Each new reply gets a typed Dx3 handoff (hf-fp-vendor-reply-<uid>), a direct paste into the fp
tmux pane, Telegram, and a bare /alignment post.

Cron: */15 * * * *. Exit 0 always, unless the mailbox cannot be reached (exit 1).
"""
import email
import imaplib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from email.header import decode_header, make_header

# Every search vendor we have written to about Faultline Pro, matched by SENDER domain, so a reply
# is caught whichever of our addresses it is sent to (axw@, engage@, faultline.pro@). The 2026-10-02
# licensing mails went out from axw@ and their Brave/Tavily replies sat unseen until 2026-10-07
# because the first version of this watch listed only ceramic.ai and exa.ai (emma-soul al:b99ad2cfa4620eeb).
WATCH_DOMAINS = ("ceramic.ai", "exa.ai", "brave.com", "tavily.com", "linkup.so")
# Founder ruling 2026-10-05 (al:481a87a5d0db81cc): Faultline Pro vendor, licensing and research
# mail goes from faultline.pro@nxtg.ai, so any mail TO it is a reply this watch must see too.
WATCH_TO = ("faultline.pro@nxtg.ai",)
# Google Cloud billing and Monitoring alerts (GoPMO 1.18.11.1.19): the prepay-balance budget mails
# faultline.pro@ through a Monitoring email channel. Prepay fails every scan at $0, so such a mail is
# not a vendor reply: it gets its own label, a P0 handoff and the top-up path.
BILLING_SENDER_DOMAINS = ("google.com",)
# Domains we write to whose replies are matched ONLY by thread headers, never by sender domain
# (GoPMO 1.18.11.7.22 item 5(b), a letter to Google). Every google.com sender is not watched: the
# mailbox also gets Google account and security notices. Only our own letters count, the Sent mail
# from a program address below, so the founder's own mail to google.com is never followed.
THREAD_ONLY_DOMAINS = ("google.com",)
PROGRAM_SENDERS = ("engage@nxtg.ai", "faultline.pro@nxtg.ai")
# A reply to a web form (emma-soul e81e70a5: the letter to Google goes through Cloud's Contact Sales
# form) starts a new thread, so thread headers cannot match it. This one narrow rule catches it: mail
# TO engage@ from a sender at exactly google.com that is not a no-reply address. Google account and
# security notices come from subdomains or no-reply senders, so they stay out.
GOOGLE_TO_ENGAGE = "google-to-engage"
ENGAGE = "engage@nxtg.ai"
# Mailbox folders read, in order. IMAP UIDs are per folder, so a message outside INBOX is keyed
# "<folder>-<uid>"; INBOX keeps the bare UID so the existing state file stays valid. A folder the
# account does not have is skipped.
WATCH_FOLDERS = ("INBOX", "Notification", "Spam", "Junk")
TOPUP_PATH = "docs/runbooks/fp-operating-runbook.md section Google prepay balance"
SINCE = "01-Oct-2026"  # covers the 2026-10-02 licensing mails as well as the 2026-10-05 consent requests
CREDS = os.path.expanduser("~/.secrets/geo-stripe.env")
STATE_DIR = os.path.expanduser("~/.cache/faultline-pro")
STATE = os.path.join(STATE_DIR, "vendor-consent-watch-state.json")
LEDGER = os.path.join(STATE_DIR, "vendor-consent-replies.jsonl")
ASIF = os.path.expanduser("~/ASIF")
DX3 = os.environ.get("DX3_API_URL", "http://100.123.83.34:8004").rstrip("/")
# The fp pane. An alert must reach it directly: alignment-say skips a mention of the author's own
# lane, so the first version's "@fp" post from --as fp woke nobody (DRYRUN wakes=[]), and Ceramic's
# 2026-10-05 reply sat 43 h unanswered although this watch had seen it.
FP_SESSION = os.environ.get("FP_TMUX_SESSION", "faultline-pro")


def load_creds():
    env = {}
    for ln in open(CREDS):
        ln = ln.strip()
        if "=" in ln and not ln.startswith("#"):
            k, v = ln.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env


def say(msg):
    """Telegram plus a bare /alignment post (no @fp: a self-mention wakes nobody)."""
    for cmd in ([os.path.join(ASIF, "scripts", "notify-telegram.sh"), msg],
                [os.path.join(ASIF, "scripts", "alignment-say"), "--as", "fp", msg]):
        try:
            subprocess.run(cmd, timeout=30, capture_output=True)
        except Exception:
            pass


def is_billing(f):
    """A Google billing or Monitoring alert, judged by sender domain only (never by display name or subject)."""
    d = f.get("sender_domain", "unknown")
    return any(d == b or d.endswith("." + b) for b in BILLING_SENDER_DOMAINS)


def classify(f):
    """A reply in a thread we started is a vendor reply, even from google.com; only other google.com
    mail is a billing alert."""
    if f.get("domain") in ("thread", GOOGLE_TO_ENGAGE):
        return "vendor-reply"
    return "google-billing" if is_billing(f) else "vendor-reply"


def sent_searches():
    """Sent-folder searches that find the letters whose replies we follow by thread headers."""
    out = [f'(SINCE {SINCE} TO "{d}")' for d in WATCH_DOMAINS]
    senders = f'OR FROM "{PROGRAM_SENDERS[0]}" FROM "{PROGRAM_SENDERS[1]}"'
    out += [f'(SINCE {SINCE} TO "{d}" {senders})' for d in THREAD_ONLY_DOMAINS]
    return out


def build_searches(ours):
    """All inbox searches, thread replies first: a message is labelled by the first search that
    finds it, so a reply in our thread is never relabelled by a domain or To search."""
    searches = []
    for mid in sorted(ours):
        searches.append(("thread", f'(SINCE {SINCE} HEADER References "{mid}")'))
        searches.append(("thread", f'(SINCE {SINCE} HEADER In-Reply-To "{mid}")'))
    searches += [(d, f'(SINCE {SINCE} FROM "{d}")') for d in WATCH_DOMAINS]
    searches += [(t, f'(SINCE {SINCE} TO "{t}")') for t in WATCH_TO]
    # Last, so a billing alert also addressed to faultline.pro@ is claimed by the To search above first
    # (scan_folder marks a message seen before it checks it).
    searches.append((GOOGLE_TO_ENGAGE, f'(SINCE {SINCE} TO "{ENGAGE}" FROM "@google.com")'))
    return searches


def handoff_body(f):
    """The typed Dx3 handoff for one message. The id comes from the mailbox UID, so a re-run updates
    the same row."""
    if classify(f) == "google-billing":
        return {
            "handoff_id": f"hf-fp-google-billing-{f['uid']}",
            "content": (f"From fp vendor-consent-watch: Google billing alert to faultline.pro@, sender domain "
                        f"{f['sender_domain']}, Zoho {f.get('folder', 'INBOX')} uid {f['uid']}. Prepay fails every Gemini scan at $0. fp reads "
                        f"the AI Studio billing balance, follows {TOPUP_PATH}, posts the balance and what it did, then "
                        f"acks this handoff. GoPMO 1.18.11.1.19."),
            "handoff_status": "OPEN", "from_machine": "NXTG-AI", "to_machine": "NXTG-AI",
            "subject": f"[fp] GOOGLE BILLING ALERT: sender domain {f['sender_domain']}", "priority": "P0",
            "project_ids": ["P-08"], "source_ref": LEDGER,
            "reason": "vendor-consent-watch: Google prepay balance or budget alert",
        }
    return {
        "handoff_id": f"hf-fp-vendor-reply-{f['uid']}",
        "content": (f"From fp vendor-consent-watch: vendor reply in a Faultline Pro thread, sender domain "
                    f"{f['sender_domain']} (watch match {f['domain']}), Zoho {f.get('folder', 'INBOX')} uid {f['uid']}. fp reads it in full, "
                    f"answers in-thread from the address our mail came from (faultline.pro@ or engage@), posts a one-line receipt, then acks this "
                    f"handoff."),
        "handoff_status": "OPEN", "from_machine": "NXTG-AI", "to_machine": "NXTG-AI",
        "subject": f"[fp] VENDOR REPLY {f['domain']}: sender domain {f['sender_domain']}", "priority": "P1",
        "project_ids": ["P-08"], "source_ref": LEDGER,
        "reason": "vendor-consent-watch: durable alert for an unanswered vendor reply",
    }


def alert_lines(f):
    """(pane text, /alignment and Telegram text). No From or Subject text: these reach an agent pane."""
    hid = handoff_body(f)["handoff_id"]
    if classify(f) == "google-billing":
        line = (f"GOOGLE BILLING ALERT to faultline.pro@: sender domain {f['sender_domain']}, Zoho "
                f"{f.get('folder', 'INBOX')} uid {f['uid']}. Dx3 handoff {hid}. GoPMO 1.18.11.1.19.")
        return (f"[vendor-consent-watch] {line} Read the AI Studio billing balance now and follow {TOPUP_PATH}; "
                f"prepay fails every scan at $0.", line + " fp reads the prepay balance and follows the top-up path.")
    line = (f"VENDOR REPLY ({f['domain']} match) in a Faultline Pro thread: sender domain {f['sender_domain']}, "
            f"Zoho {f.get('folder', 'INBOX')} uid {f['uid']}. Dx3 handoff {hid}.")
    return (f"[vendor-consent-watch] {line} Read it in that Zoho folder, answer in-thread from the address our mail came from, "
            f"post a receipt, ack the handoff.",
            line + " fp answers in-thread from the address our mail came from.")


def mint_handoff(f):
    """Typed Dx3 handoff per message, so it survives an idle pane. Returns the record_id, or None
    (logged, never fatal)."""
    body = handoff_body(f)
    try:
        req = urllib.request.Request(DX3 + "/api/cognitive/upsert_handoff", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read()).get("record_id")
    except Exception as e:
        print(f"vendor-consent-watch: handoff mint failed for uid {f['uid']}: {type(e).__name__}")
        return None


def wake_fp(msg):
    """Paste the alert into the fp pane and press Enter, the same path alignment-say uses for a
    mention. Returns True when the keys were sent (a nudge, not proof the pane read it)."""
    try:
        panes = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}"],
                               capture_output=True, text=True, timeout=10).stdout.split()
        target = next((p for p in panes if p.split(":")[0] == FP_SESSION), None)
        if not target:
            print(f"vendor-consent-watch: no live tmux session {FP_SESSION}")
            return False
        subprocess.run(["tmux", "load-buffer", "-b", "fp-vendor-reply", "-"], input=msg, text=True,
                       check=True, timeout=10)
        subprocess.run(["tmux", "paste-buffer", "-b", "fp-vendor-reply", "-d", "-t", target], check=True, timeout=10)
        time.sleep(0.3)
        subprocess.run(["tmux", "send-keys", "-t", target, "Enter"], check=True, timeout=10)
        return True
    except Exception as e:
        print(f"vendor-consent-watch: pane wake failed: {type(e).__name__}")
        return False


def text(h):
    return str(make_header(decode_header(h or "")))


def sender_domain(from_header):
    """The sender's email domain, or "unknown". Only this, never the display name or the subject,
    leaves the ledger: alert text is pasted into an agent pane and posted to /alignment, and a
    From or Subject line is written by whoever sent the mail."""
    m = re.search(r"@([A-Za-z0-9.-]{1,253})>?\s*$", from_header or "")
    return m.group(1).lower() if m else "unknown"


def is_no_reply(from_header):
    """True for an automated sender address: no-reply, noreply, do-not-reply and the like."""
    m = re.search(r"([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+>?\s*$", from_header or "")
    return bool(m) and re.search(r"no-?reply|do-?not-?reply", m.group(1), re.I) is not None


def domain_match_ok(watch, sd, from_header=""):
    """A watched-domain hit counts only when the sender's own domain is that domain or a subdomain.
    Thread and To matches pass through: a reply in our thread may come from any address. The
    google-to-engage rule takes only a person at exactly google.com."""
    if watch == GOOGLE_TO_ENGAGE:
        return sd == "google.com" and not is_no_reply(from_header)
    if watch not in WATCH_DOMAINS:
        return True
    return sd == watch or sd.endswith("." + watch)


def message_key(folder, uid):
    """The seen-state key and alert id for a message: the bare UID in INBOX, "<folder>-<uid>" elsewhere."""
    return uid if folder == "INBOX" else f"{folder}-{uid}"


def scan_folder(m, folder, searches, seen):
    """New matches in one folder. Returns [] when the folder cannot be selected."""
    try:
        typ, _ = m.select(f'"{folder}"', readonly=True)
    except imaplib.IMAP4.error:
        return []
    if typ != "OK":
        return []
    found = []
    for domain, criteria in searches:
        _, data = m.uid("SEARCH", None, criteria)
        for uid in data[0].split():
            key = message_key(folder, uid.decode())
            if key in seen:
                continue
            _, dd = m.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            h = email.message_from_bytes(dd[0][1])
            seen.add(key)
            # Zoho's IMAP FROM search also matches the display name ("Donald Brave" hit brave.com,
            # uid 1040), so a domain match must be the sender's actual domain.
            if not domain_match_ok(domain, sender_domain(text(h["From"])), text(h["From"])):
                continue
            found.append({"uid": key, "folder": folder, "domain": domain, "from": text(h["From"]),
                          "subject": text(h["Subject"])[:140], "date": h["Date"]})
    return found


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    seen = set()
    if os.path.exists(STATE):
        seen = set(json.load(open(STATE)).get("seen_uids", []))
    env = load_creds()
    try:
        m = imaplib.IMAP4_SSL("imap.zoho.com", 993)
        m.login(env["ZOHO_SMTP_USER"], env["ZOHO_APP_PASSWORD"])
        m.select("INBOX", readonly=True)
    except Exception as e:
        print(f"vendor-consent-watch: mailbox unreachable: {type(e).__name__}")
        return 1
    found = []
    # Replies to anything we sent to a watched domain, matched by threading headers, so a reply from
    # an address on another domain (a reseller, a personal address) is still caught. Thread searches
    # run first, so a reply that also matches a domain or To search is labelled "thread".
    searches = []
    ours = set()
    m.select("Sent", readonly=True)
    for crit in sent_searches():
        _, data = m.uid("SEARCH", None, crit)
        for uid in data[0].split():
            _, dd = m.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
            mid = email.message_from_bytes(dd[0][1])["Message-ID"]
            if mid:
                ours.add(mid.strip())
    searches = build_searches(ours)
    for folder in WATCH_FOLDERS:
        found += scan_folder(m, folder, searches, seen)
    m.logout()
    for f in found:
        f["sender_domain"] = sender_domain(f["from"])
        f["handoff_record_id"] = mint_handoff(f)
        f["kind"] = classify(f)
        pane_text, post_text = alert_lines(f)
        f["pane_woken"] = wake_fp(pane_text)
        with open(LEDGER, "a") as fh:
            fh.write(json.dumps(f) + "\n")
        say(post_text)
    json.dump({"seen_uids": sorted(seen)}, open(STATE, "w"))
    print(f"vendor-consent-watch: {len(found)} new")
    return 0


if __name__ == "__main__":
    sys.exit(main())
