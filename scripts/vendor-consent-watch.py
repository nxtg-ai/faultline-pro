#!/usr/bin/env python3
"""vendor-consent-watch.py: alert on any reply from a search vendor Faultline Pro has written to.

Prereg amendment A1 (docs/research/2026-10-05-prereg-retrieval-provider-comparison-v1.md)
suspends the Ceramic and Exa arms until each vendor answers the consent request in
docs/research/2026-10-05-search-vendor-consent-drafts.md. EMMA-SOUL's ruling
(al:f24b3825e397565d) asks for a watch that catches ANY reply, a decline as much as a
yes. So this matches every message from a watched domain, not only a positive one.

engage@nxtg.ai delivers into the Zoho INBOX this reads (probed 2026-10-05).
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


def mint_handoff(f):
    """Typed Dx3 handoff per reply, so it survives an idle pane. The id comes from the mailbox UID,
    so a re-run updates the same row. Returns the record_id, or None (logged, never fatal)."""
    body = {
        "handoff_id": f"hf-fp-vendor-reply-{f['uid']}",
        "content": (f"From fp vendor-consent-watch: vendor reply in a Faultline Pro thread. From {f['from']}, "
                    f"subject '{f['subject']}', {f['date']} (Zoho INBOX uid {f['uid']}). fp reads it in full, "
                    f"answers in-thread from faultline.pro@nxtg.ai, posts a one-line receipt, then acks this "
                    f"handoff. Prereg A1 arms stay SUSPENDED until written consent is confirmed."),
        "handoff_status": "OPEN", "from_machine": "NXTG-AI", "to_machine": "NXTG-AI",
        "subject": f"[fp] VENDOR REPLY {f['domain']}: {f['from'][:60]}", "priority": "P1",
        "project_ids": ["P-08"], "source_ref": LEDGER,
        "reason": "vendor-consent-watch: durable alert for an unanswered vendor reply",
    }
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
    searches = [(d, f'(SINCE {SINCE} FROM "{d}")') for d in WATCH_DOMAINS]
    searches += [(t, f'(SINCE {SINCE} TO "{t}")') for t in WATCH_TO]
    # Replies to anything we sent to a watched domain, matched by threading headers, so a reply from
    # an address on another domain (a reseller, a personal address) is still caught.
    ours = set()
    m.select("Sent", readonly=True)
    for d in WATCH_DOMAINS:
        _, data = m.uid("SEARCH", None, f'(SINCE {SINCE} TO "{d}")')
        for uid in data[0].split():
            _, dd = m.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
            mid = email.message_from_bytes(dd[0][1])["Message-ID"]
            if mid:
                ours.add(mid.strip())
    m.select("INBOX", readonly=True)
    for mid in ours:
        searches.append(("thread", f'(SINCE {SINCE} HEADER References "{mid}")'))
        searches.append(("thread", f'(SINCE {SINCE} HEADER In-Reply-To "{mid}")'))
    for domain, criteria in searches:
        _, data = m.uid("SEARCH", None, criteria)
        for uid in data[0].split():
            u = uid.decode()
            if u in seen:
                continue
            _, dd = m.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
            h = email.message_from_bytes(dd[0][1])
            found.append({"uid": u, "domain": domain, "from": text(h["From"]),
                          "subject": text(h["Subject"])[:140], "date": h["Date"]})
            seen.add(u)
    m.logout()
    for f in found:
        f["handoff_record_id"] = mint_handoff(f)
        line = (f"VENDOR REPLY ({f['domain']} match) in a Faultline Pro thread: from {f['from']}, "
                f"subject '{f['subject']}', {f['date']}. Dx3 handoff hf-fp-vendor-reply-{f['uid']}.")
        f["pane_woken"] = wake_fp(f"[vendor-consent-watch] {line} Read it in the Zoho inbox, answer in-thread "
                                  f"from faultline.pro@, post a receipt, ack the handoff.")
        with open(LEDGER, "a") as fh:
            fh.write(json.dumps(f) + "\n")
        say(line + " fp answers in-thread from faultline.pro@; prereg A1 arms stay SUSPENDED until written consent.")
    json.dump({"seen_uids": sorted(seen)}, open(STATE, "w"))
    print(f"vendor-consent-watch: {len(found)} new")
    return 0


if __name__ == "__main__":
    sys.exit(main())
