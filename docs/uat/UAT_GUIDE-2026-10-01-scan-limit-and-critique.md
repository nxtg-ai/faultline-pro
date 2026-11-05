# UAT guide: 2026-10-01

Two tests, run on production at https://faultline.nxtg.ai. About 10 minutes.

| # | What you are testing | Ready to test? |
|---|---|---|
| 1 | Personal plan stops at 25 scans a month and offers an upgrade (A-264, faultline-web #46) | Yes, live now |
| 2 | The critique panel still works after the spend-hole fix (codex HIGH) | After the critique PR merges and deploys. fp will post on /alignment when it does |

The consensus gate (Enterprise only) is already verified on production by fp with zero spend. No action needed from you there.

---

## Test 1: Personal plan stops at 25 scans

**How it works (so you know what you are setting).** The plan is the Clerk user's **public metadata** `plan`. The monthly count is the Clerk user's **private metadata** `scanUsage`, keyed by month (`"2026-10"`). The server refuses scan 26 before calling the scan engine, so the refused scan costs nothing.

You do not need to buy a plan or run 25 scans. You set both values in the Clerk dashboard.

### Setup (Clerk dashboard, PRODUCTION instance)

1. Use a **test account**, not your own, and not a paying customer. Sign up a fresh one on the site if needed (e.g. a `+uat` email alias).
2. Clerk Dashboard → switch to the **Production** instance → Users → open the test user → **Metadata**.
3. **Public metadata**, set:
   ```json
   { "plan": "personal" }
   ```
4. **Private metadata**, set (keep any keys already there, such as `stripeCustomerId`, and add this one):
   ```json
   { "scanUsage": { "2026-10": 25 } }
   ```
   If the test runs on or after 1 November, use `"2026-11"`. The server keys the month in UTC.
5. Save both.

### Run

6. Sign in on the site as the test user.
7. Paste any short text (e.g. `The Eiffel Tower is located in Berlin.`) and press Scan.

### Pass

- [ ] The results page shows an amber box: **"Monthly scan limit reached"**, with "You have used every scan in your plan this month…"
- [ ] It has an **"Upgrade plan"** button.
- [ ] Clicking it opens **/pricing**, which shows Personal as **25 scans/month**.
- [ ] No scan results appear: no claims, no verdicts.
- [ ] Private metadata still reads `25` (a refused scan is not counted).

### Fail

- Results appear (the limit is not enforced), or a generic error shows instead of the amber box, or "Upgrade plan" goes anywhere other than /pricing.

### Optional positive control (costs one real scan, about a cent to 30 cents)

8. Set `scanUsage` to `{ "2026-10": 24 }` and scan once. Expect normal results, and the count becomes `25`.
9. Scan again. Expect the amber box.

### Clean up

10. Set public metadata `plan` back to `"free"` (or delete the test user). Delete `scanUsage` from private metadata if you will reuse the account.

---

## Test 2: Critique still works after the fix

**What changed.** `/api/critique` makes a paid AI call. Before the fix, anyone could call it directly without running a scan. Now a scan hands the browser a one-time ticket that only works for that scan's text. Normal use should look exactly the same.

### In the browser (the part only you can judge)

1. Signed in or anonymous, scan text with a false claim: `The Eiffel Tower is located in Berlin. Water boils at 50 degrees Celsius at sea level.`
2. On the results page, under **Verification**, wait for the **Critique** panel.

**Pass:**
- [ ] The Critique panel fills in with a critique and an **improved prompt**. It does not spin forever.
- [ ] Press the browser Back button, then Forward. The panel reappears from cache with no new request.

### From a terminal (proves the hole is shut; costs nothing)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://faultline.nxtg.ai/api/critique \
  -H 'content-type: application/json' \
  -d '{"claims":[],"verifications":{},"text":"x"}'
```

- [ ] Prints **401** (no ticket). Before the fix this reached the paid AI engine.

fp also runs the replay and wrong-text checks with automated tests; you do not need to.

---

## Report back

Reply "UAT 1 pass" / "UAT 2 pass", or paste what you saw. A screenshot of the amber box is enough evidence for Test 1.
