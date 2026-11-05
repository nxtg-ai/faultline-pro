"""Counting rules of scripts/stripe-revenue-evidence.py (ARU-01 scoreboard). Run: python3 -m pytest -q scripts/test_stripe_revenue_evidence.py"""
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location("ev", pathlib.Path(__file__).with_name("stripe-revenue-evidence.py"))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)


def cust(cid, internal=False, cash=0, renewals=0, refunded=0, zero=0, status="active", cancel_end=False, mixed=False):
    return {"customer": cid, "domain": "example.com", "internal": internal, "cash_cents": cash, "renewals": renewals,
            "refunded_cents": refunded, "zero_dollar_paid_invoices": zero, "paid_invoices": 1 if cash else 0,
            "refund_attribution_mixed": mixed,
            "subscriptions": [{"id": "sub_" + cid, "status": status, "cancel_at_period_end": cancel_end}]}


def test_internal_cash_never_counts_as_revenue():
    b = ev.scoreboard([cust("a", internal=True, cash=9500, renewals=4)], "Faultline")
    assert b["verified_external_cash_collected_lifetime_usd"] == 0
    assert b["external_paying_customers"] == 0
    assert b["excluded_internal_customers"] == 1 and b["excluded_internal_cash_usd"] == 95.0


def test_coupon_only_external_customer_is_not_paying():
    b = ev.scoreboard([cust("g", zero=4)], "Faultline")
    assert b["external_paying_customers"] == 0
    assert b["external_coupon_or_zero_only_customers"] == 1
    assert b["verified_external_cash_collected_lifetime_usd"] == 0


def test_external_cash_net_of_refunds_and_recurring():
    b = ev.scoreboard([cust("x", cash=3800, renewals=1, refunded=1900), cust("y", cash=4900)], "Faultline")
    assert b["external_gross_paid_usd"] == 87.0
    assert b["external_refunds_usd"] == 19.0
    assert b["verified_external_cash_collected_lifetime_usd"] == 68.0
    assert b["external_paying_customers"] == 2
    assert b["external_recurring_customers"] == 1


def test_cancellations_count_external_only_and_include_cancel_at_period_end():
    b = ev.scoreboard([cust("c1", cash=1900, status="canceled"), cust("c2", cash=1900, cancel_end=True),
                       cust("c3", internal=True, status="canceled")], "Faultline")
    assert b["external_cancellations"] == 2


def test_internal_list_parsing(tmp_path):
    p = tmp_path / "internal.txt"
    p.write_text("# comment\ncus_123\n@nxtg.ai\nSomeone@Example.com\n\n")
    ids, emails, domains = ev.load_internal(str(p))
    assert ids == {"cus_123"} and domains == {"nxtg.ai"} and emails == {"someone@example.com"}
