#!/usr/bin/env python3
"""vendor-consent-watch.py: alert on any reply from Ceramic or Exa.

Prereg amendment A1 (docs/research/2026-10-05-prereg-retrieval-provider-comparison-v1.md)
suspends the Ceramic and Exa arms until each vendor answers the consent request in
docs/research/2026-10-05-search-vendor-consent-drafts.md. EMMA-SOUL's ruling
(al:f24b3825e397565d) asks for a watch that catches ANY reply, a decline as much as a
yes. So this matches every message from a watched domain, not only a positive one.

engage@nxtg.ai delivers into the Zoho INBOX this reads (probed 2026-10-05).
Read-only on the mailbox (readonly select, BODY.PEEK, headers only). The credentials
come from ~/.secrets/geo-stripe.env and are never printed. Each message alerts once:
seen UIDs are kept in the state file.

Cron: */15 * * * *. Exit 0 always, unless the mailbox cannot be reached (exit 1).
"""
import email
import imaplib
import json
import os
import subprocess
import sys
from email.header import decode_header, make_header

WATCH_DOMAINS = ("ceramic.ai", "exa.ai")
SINCE = "05-Oct-2026"  # the requests were sent on this day; older Exa mail is the 2026-10-02 thread
CREDS = os.path.expanduser("~/.secrets/geo-stripe.env")
STATE_DIR = os.path.expanduser("~/.cache/faultline-pro")
STATE = os.path.join(STATE_DIR, "vendor-consent-watch-state.json")
LEDGER = os.path.join(STATE_DIR, "vendor-consent-replies.jsonl")
ASIF = os.path.expanduser("~/ASIF")


def load_creds():
    env = {}
    for ln in open(CREDS):
        ln = ln.strip()
        if "=" in ln and not ln.startswith("#"):
            k, v = ln.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env


def say(msg):
    for cmd in ([os.path.join(ASIF, "scripts", "notify-telegram.sh"), msg],
                [os.path.join(ASIF, "scripts", "alignment-say"), "--as", "fp", msg]):
        try:
            subprocess.run(cmd, timeout=30, capture_output=True)
        except Exception:
            pass


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
    for domain in WATCH_DOMAINS:
        _, data = m.uid("SEARCH", None, f'(SINCE {SINCE} FROM "{domain}")')
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
        with open(LEDGER, "a") as fh:
            fh.write(json.dumps(f) + "\n")
        say(f"@fp VENDOR REPLY ({f['domain']}) to the Faultline consent request: "
            f"from {f['from']}, subject '{f['subject']}', {f['date']}. Read it in the engage@/axw Zoho inbox; "
            f"prereg A1 arms stay SUSPENDED until written consent is confirmed.")
    json.dump({"seen_uids": sorted(seen)}, open(STATE, "w"))
    print(f"vendor-consent-watch: {len(found)} new")
    return 0


if __name__ == "__main__":
    sys.exit(main())
