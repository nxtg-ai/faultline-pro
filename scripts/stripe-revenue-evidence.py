#!/usr/bin/env python3
"""stripe-revenue-evidence.py: the ARU-01 scoreboard rows, read from live Stripe.

DIRECTIVE-NXTG-20261011-FAULTLINE-ARU-01 counts revenue only on an independent Stripe paid
invoice from an external customer. Checkout started, activation events, $0 or 100%-coupon
subscriptions and founder or internal tests do not count. This prints the rows of
~/ASIF/initiatives/faultline-aru-01/TRACKER.md "Scoreboard" from Stripe alone, no model.

Rules:
  - Scope: subscriptions (any status) with an item whose product name contains --product
    (default "Faultline"). Faultline sells subscriptions only; one-off payments are not read.
  - Internal: a customer listed in --internal (customer id, email, or @domain, one per line;
    default ~/.config/faultline/internal-payers.txt, kept out of git). Internal rows are
    reported as excluded, never summed into revenue.
  - Cash: invoices with status paid and amount_paid > 0, livemode only. An invoice paid at
    $0 (a 100% coupon) is excluded and counted as such.
  - Refunds: amount_refunded on that customer's succeeded charges. If an external customer
    also holds a non-Faultline subscription the refund cannot be attributed by product; the
    row says so.
  - Cancellations: Faultline subscriptions with status canceled, or active with
    cancel_at_period_end, external customers only.

Prints customer ids and email DOMAINS only, never an address, and the key's sha12, never
the key. Exit 0 with rows printed; exit 2 when Stripe cannot be read (no rows are guessed).

  python3 scripts/stripe-revenue-evidence.py            # table
  python3 scripts/stripe-revenue-evidence.py --json     # same rows as JSON (for typed records)
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_KEY_FILE = "~/.config/stripe/product-oracle-stripe.env"
DEFAULT_KEY_NAME = "STRIPE_READONLY_KEY"
DEFAULT_INTERNAL = "~/.config/faultline/internal-payers.txt"


def load_key(path, name):
    for ln in open(os.path.expanduser(path)):
        if ln.startswith(name + "="):
            return ln.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"stripe-revenue-evidence: {name} not found in {path}")


def load_internal(path):
    ids, emails, domains = set(), set(), set()
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        return ids, emails, domains
    for ln in open(p):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        if ln.startswith("cus_"):
            ids.add(ln)
        elif ln.startswith("@"):
            domains.add(ln[1:].lower())
        elif "@" in ln:
            emails.add(ln.lower())
    return ids, emails, domains


class Stripe:
    def __init__(self, key):
        self.auth = "Basic " + base64.b64encode((key + ":").encode()).decode()
        self.products = {}

    def get(self, path, **params):
        url = "https://api.stripe.com/v1/" + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, headers={"Authorization": self.auth})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    def all(self, path, **params):
        """Every object of a list endpoint, following has_more."""
        params = dict(params, limit=100)
        while True:
            page = self.get(path, **params)
            yield from page["data"]
            if not page.get("has_more"):
                return
            params["starting_after"] = page["data"][-1]["id"]

    def product_name(self, pid):
        if pid not in self.products:
            self.products[pid] = self.get("products/" + pid).get("name", "")
        return self.products[pid]


def ts(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d") if t else None


def collect(s, product, internal):
    ids, emails, domains = internal
    subs_by_cust, other_product_custs = {}, set()
    for sub in s.all("subscriptions", status="all"):
        if not sub.get("livemode"):
            continue
        names = [s.product_name(it["price"]["product"]) for it in sub["items"]["data"]]
        if any(product.lower() in n.lower() for n in names):
            subs_by_cust.setdefault(sub["customer"], []).append(sub)
        else:
            other_product_custs.add(sub["customer"])

    customers = []
    for cid, subs in sorted(subs_by_cust.items()):
        c = s.get("customers/" + cid)
        email = (c.get("email") or "").lower()
        domain = email.split("@")[-1] if "@" in email else ""
        internal_hit = cid in ids or email in emails or domain in domains
        paid, zero_paid, cycles = [], 0, 0
        for sub in subs:
            for inv in s.all("invoices", subscription=sub["id"]):
                if inv["status"] != "paid" or not inv.get("livemode"):
                    continue
                if inv["amount_paid"] > 0:
                    paid.append(inv)
                    cycles += inv.get("billing_reason") == "subscription_cycle"
                else:
                    zero_paid += 1
        charges = [ch for ch in s.all("charges", customer=cid) if ch["status"] == "succeeded" and ch.get("livemode")]
        customers.append({
            "customer": cid,
            "domain": domain or "(none)",
            "internal": internal_hit,
            "subscriptions": [{"id": x["id"], "status": x["status"], "cancel_at_period_end": x.get("cancel_at_period_end", False),
                               "created": ts(x["created"]), "canceled_at": ts(x.get("canceled_at"))} for x in subs],
            "paid_invoices": len(paid),
            "cash_cents": sum(i["amount_paid"] for i in paid),
            "renewals": cycles,
            "zero_dollar_paid_invoices": zero_paid,
            "first_paid": min((ts(i["created"]) for i in paid), default=None),
            "last_paid": max((ts(i["created"]) for i in paid), default=None),
            "refunded_cents": sum(ch.get("amount_refunded", 0) for ch in charges),
            "refund_attribution_mixed": cid in other_product_custs,
        })
    return customers


def scoreboard(customers, product):
    ext = [c for c in customers if not c["internal"]]
    ext_paying = [c for c in ext if c["cash_cents"] > 0]
    gross = sum(c["cash_cents"] for c in ext_paying)
    refunds = sum(c["refunded_cents"] for c in ext_paying)
    cancels = sum(1 for c in ext for x in c["subscriptions"] if x["status"] == "canceled" or x["cancel_at_period_end"])
    return {
        "as_of": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "product": product,
        "verified_external_cash_collected_lifetime_usd": round((gross - refunds) / 100, 2),
        "external_gross_paid_usd": round(gross / 100, 2),
        "external_refunds_usd": round(refunds / 100, 2),
        "external_paying_customers": len(ext_paying),
        "external_recurring_customers": sum(1 for c in ext_paying if c["renewals"] >= 1),
        "external_cancellations": cancels,
        "external_coupon_or_zero_only_customers": sum(1 for c in ext if c["cash_cents"] == 0),
        "excluded_internal_customers": sum(1 for c in customers if c["internal"]),
        "excluded_internal_cash_usd": round(sum(c["cash_cents"] for c in customers if c["internal"]) / 100, 2),
        "refund_attribution_mixed": any(c["refund_attribution_mixed"] for c in ext_paying),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--product", default="Faultline")
    ap.add_argument("--key-file", default=os.environ.get("STRIPE_EVIDENCE_KEY_FILE", DEFAULT_KEY_FILE))
    ap.add_argument("--key-name", default=os.environ.get("STRIPE_EVIDENCE_KEY_NAME", DEFAULT_KEY_NAME))
    ap.add_argument("--internal", default=os.environ.get("STRIPE_EVIDENCE_INTERNAL", DEFAULT_INTERNAL))
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    key = load_key(a.key_file, a.key_name)
    internal = load_internal(a.internal)
    s = Stripe(key)
    try:
        account = s.get("account").get("id")
        customers = collect(s, a.product, internal)
    except urllib.error.HTTPError as e:
        print(f"stripe-revenue-evidence: Stripe read failed, HTTP {e.code} on {e.url.split('?')[0]}; no rows printed", file=sys.stderr)
        return 2
    except urllib.error.URLError as e:
        print(f"stripe-revenue-evidence: Stripe unreachable ({e.reason}); no rows printed", file=sys.stderr)
        return 2
    board = scoreboard(customers, a.product)
    board["instrument"] = {
        "account": account, "key_sha12": hashlib.sha256(key.encode()).hexdigest()[:12],
        "internal_list_sha12": hashlib.sha256(open(os.path.expanduser(a.internal), "rb").read()).hexdigest()[:12]
        if os.path.exists(os.path.expanduser(a.internal)) else None,
        "customers_in_scope": len(customers),
    }
    if a.json:
        print(json.dumps({"scoreboard": board, "customers": customers}, indent=1))
        return 0
    i = board["instrument"]
    print(f"ARU-01 Stripe evidence, {board['product']}, {board['as_of']} (account {i['account']}, key sha12 {i['key_sha12']}, "
          f"internal list sha12 {i['internal_list_sha12']}, {i['customers_in_scope']} customers in scope)")
    for k in ("verified_external_cash_collected_lifetime_usd", "external_gross_paid_usd", "external_refunds_usd",
              "external_paying_customers", "external_recurring_customers", "external_cancellations",
              "external_coupon_or_zero_only_customers", "excluded_internal_customers", "excluded_internal_cash_usd",
              "refund_attribution_mixed"):
        print(f"  {k}: {board[k]}")
    print("  customers:")
    for c in customers:
        subs = ", ".join(f"{x['id']} {x['status']}{' cancel@end' if x['cancel_at_period_end'] else ''}" for x in c["subscriptions"])
        print(f"    {c['customer']} domain={c['domain']} {'INTERNAL' if c['internal'] else 'external'} "
              f"paid={c['paid_invoices']} cash=${c['cash_cents'] / 100:.2f} renewals={c['renewals']} "
              f"zero_paid={c['zero_dollar_paid_invoices']} refunded=${c['refunded_cents'] / 100:.2f} [{subs}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
