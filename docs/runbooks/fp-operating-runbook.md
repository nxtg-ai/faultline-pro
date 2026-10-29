# fp operating runbook

How the fp lane ships, deploys, releases and verifies Faultline. Read this before doing any of those things. Every item here was rediscovered at least once; if you learn a new one, add it here in the same change.

Last verified: 2026-10-02 (v0.11.1 release).

## Topology

| Surface | Where | Deploys how | Version check |
|---|---|---|---|
| Scan engine `faultline-api` | Fly.io, `https://faultline-api.fly.dev` | `.github/workflows/fly-deploy.yml`: on push to `main` touching `packages/api/**`, `Dockerfile`, `packages/api/fly.toml`; or `gh workflow run fly-deploy.yml --ref main` | `curl -s https://faultline-api.fly.dev/health` (`version` comes from `packages/api/package.json`) |
| CLI `@nxtg/faultline` | npm | `.github/workflows/publish.yml`, manual dispatch only | `npm view @nxtg/faultline version` |
| Web app `faultline-web` | Vercel project `prj_3iRCGgashuN0Vw3RwKUtloMqfxQ1`, team `team_thKXpZjHb8IJPXODC5eaaA6C`, `https://faultline.nxtg.ai` | Vercel auto-deploys `main` of `nxtg-ai/faultline-web` | commit status context containing "Vercel" on the merge commit |

faultline-web calls the engine's `POST /scan/stream` and `POST /critique` with the server key `FAULTLINE_API_KEY` (keyId `admin`) plus `x-user-tier`. The engine trusts `x-user-tier` only from that key.

## Release (atomic, all steps or no version bump)

npm publishing runs in GitHub Actions with OIDC trusted publishing (npm retired 2FA-token publishing). **Never `npm login` / `npm publish` locally.** `npm whoami` returning E401 on NXTG-AI is normal.

1. Bump `packages/cli/package.json` and `packages/api/package.json` to the same version; bump `packages/mcp/package.json`'s `@nxtg/faultline` dependency; `npm install --package-lock-only --ignore-scripts`.
2. Roll `CHANGELOG.md` `[Unreleased]` into `## [vX.Y.Z] — YYYY-MM-DD`, leave an empty `[Unreleased]`.
3. Update pinned versions in `README.md`, `CLAUDE.md`, `packages/*/README.md` (`grep -rn "<old version>"`).
4. Run `packages/api` and `packages/cli` vitest; commit `release: vX.Y.Z`; push `main` (the api `package.json` change triggers the Fly deploy).
5. `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
6. `gh release create vX.Y.Z --title vX.Y.Z --notes-file <the CHANGELOG section> --prerelease`. Keep `--prerelease` while the release stage is alpha or beta (release-stage skill §3.7).

**Release stage** (dx3-pm owns the value; registry `~/ASIF/governance/product-maturity-registry.yml`): Faultline is **alpha**. The one constant is `packages/cli/cli/release-stage.ts`; it drives `faultline version` and `GET /health` `stage`. `packages/cli/tests/release-stage.test.ts` fails until README, npm README, llms.txt and the CHANGELOG stage line match it. Never put the stage in the SemVer string. On a promotion: registry first (dx3-pm, founder rules beta and up), then flip the constant, fix what the test names, release.
7. `gh workflow run publish.yml --ref vX.Y.Z`, then `gh run watch`.
8. Verify all four agree: `npm view @nxtg/faultline version`, `/health` version, tag, then `gh workflow run version-parity.yml` must pass.

Push quirk: the pre-push hook chain can print `failed to push some refs` and still let later `&&` steps run. After any push, check `git status -sb` shows no `[ahead N]`.

## Docs ship with the code

A change is not done until, in the same commit or PR: `CHANGELOG.md` `[Unreleased]` has it; affected READMEs and `llms.txt` are right; the NEXUS row status matches production; and, for a user-visible web change, faultline-web's public changelog `lib/changelog.ts` (page `/changelog`) has an entry. Before declaring anything shipped: `git log $(git describe --tags --abbrev=0)..HEAD` against `CHANGELOG.md`.

## Changing faultline-web (another lane's repo)

**fw owns faultline-web.** Before touching any faultline-web issue (a bug, a UAT finding, an env problem), check whether fw is already on it: read today's `/home/axw/ASIF/governance/alignment/<date>.jsonl` for fw posts and `tmux capture-pane -p -t faultline-web:1.1 -S -80`. If fw has it, do not start a parallel fix; post findings to fw instead. 2026-10-01: fp and fw fixed the same critique panel in parallel (fp #55, fw #57/#58) and fp asked Asif for things fw had already done, twice in one evening.

- Never touch `/home/axw/projects/faultline-web`'s working tree; fw works there. Use a worktree: `git -C /home/axw/projects/faultline-web worktree add <scratch>/fw-<topic> -b <branch> origin/main`.
- Customer-facing copy (pricing, changelog, FAQ, llms.txt, UI text) needs **CE copy review** (`@ce` on /alignment) before merge. CE rules: plain words, short sentences, no em-dashes in prose (colons or commas; em-dashes inside code fences are fine), no hype, no "we"-voice slogans.
- Security fixes get an adversarial review from **codex** (`@codex`) before merge; the author never grades its own fix.
- Merge with `gh pr merge <n> -R nxtg-ai/faultline-web --squash --match-head-commit <reviewed sha>`.
- After merge, verify on production, not in tests.

## Environment and secrets

- Server key for live engine probes: `FAULTLINE_API_KEY` in `/home/axw/projects/faultline-web/.env.local` (same value as `packages/api/.env`). Read it into a shell variable; never print it.
- faultline-web needs **unprefixed** `KV_REST_API_URL` and `KV_REST_API_TOKEN` (Upstash Redis via the Vercel Marketplace). A Vercel storage connection made with a custom prefix (it was `fp_kv_`) leaves them unset, and the rate limiters, anon quota and shared scans fail open. That was the state from at least 2026-05-18 until 2026-10-01 (the old store was also later uninstalled). fw restored it 2026-10-01 (faultline-web PR 52): store faultline-web-kv, no prefix, daily spend alert. **Before calling a cross-repo item open, read /alignment (`~/ASIF/governance/alignment/<date>.jsonl`) for the owning lane's posts; the owner may already have closed it.** fp's Vercel token gets 403 on env vars and integrations: Asif or fw change those.
- Measurement key: `FAULTLINE_MEASUREMENT_KEY` (repo secret and Fly secret) is for internal measurement runs only: the Accuracy G0 workflow and `scripts/measure-cost-per-claim.mjs`. It may call only `POST /admin/verify-claims` and `GET /usage`; every other route answers it 403. Its spend rows carry tier `measurement`, so they read apart from faultline-web's traffic on the server key, and the fleet spend cap never refuses it. Set it with a fresh random value as the repo secret, then `gh workflow run fly-ops.yml -f action=measurement-key-set` (restarts the machine; `measurement-key-unset` removes it). It must differ from `FAULTLINE_API_KEY`; if it is equal, the API logs one warning at startup and ignores it. Without it the runners fall back to the admin key and print that the run is not labelled. Locally, put a `FAULTLINE_MEASUREMENT_KEY=` line in `~/.config/faultline/measurement-key.env`. Details: `docs/provider-spend-cap.md`, "The measurement key".
- Git under conda: `env -u LD_LIBRARY_PATH PATH=/usr/bin:/bin /usr/bin/git`.

- `FAULTLINE_EVIDENCE_FETCH=off` (Fly secret or env) stops the API fetching cited pages for evidence passages (GoPMO 1.18.11.3 P1b). Default on. The engine follows redirects itself (at most 5) and, before each hop, asks that site's robots.txt (`packages/cli/evidence/robots.ts`, cached per origin for 24 h, in memory, so a deploy clears it); every request, robots.txt included, goes through `fetchOutbound` (private addresses refused). One 6 s deadline covers a whole source, robots.txt reads and redirect hops included; 1.5 MB per page, 500 KiB per robots.txt. Rules are matched without regexes under a fixed work budget, so a hostile robots.txt cannot stall the API (it disallows instead). Google's grounding host is never requested, robots.txt included. The API test suite sets it off in `packages/api/vitest.config.ts`; `tests/evidence-routes.test.ts` turns it on with a stubbed network.

- `FAULTLINE_PASSAGE_LEG=on` (set in `packages/api/fly.toml` `[env]` since 2026-10-14) turns on the independent passage leg. It runs only beside Gemini-grounded verdicts, only with a model measured under the cap (`gpt-4o-mini`; any other `FAULTLINE_PASSAGE_SEARCH_MODEL` leaves it off), with a 12 s deadline on the search call, and `FAULTLINE_EVIDENCE_FETCH=off` stops it too. The leg is OpenAI web_search on each Gemini-verified claim, its result pages quoted into `independentEvidence`. Off unless set; it also needs `OPENAI_API_KEY`. `FAULTLINE_PASSAGE_SEARCH_MODEL` overrides the model (default `gpt-4o-mini`). Authorization: emma-soul al:e615798a8e8109c0, 40 USD build-and-test cap, at most 1.5 cents per checked claim in production. Measured 2026-10-14: gpt-4o-mini about 1.1 to 1.3 cents per claim, gpt-4.1-mini about 1.4 to 1.7 cents (over the cap). Gemini grounding Links are never fetched (Google's terms; emma-soul al:07b45f0562efbbf0).

## Customer keys (closed)

`FAULTLINE_CUSTOMER_KEYS` is **on** in production since 2026-10-15 (emma-soul ruling Dx3 e2909e46, GoPMO 1.18.11.6.8): admin callers can issue non-admin keys. It was closed from 2026-10-14 (al:837ec6cea3437a7d) until the tenancy change (main 967bc0b) and the reopen conditions (a3f1eb4) were live and the production two-key canary was clean. Kill switch: `gh workflow run fly-ops.yml -f action=customer-keys-off` (restarts the machine and empties the in-memory keystore). With the flag off, the engine issues only admin keys, and `PATCH /keys/:id` cannot re-scope a key to non-admin permissions.

**How a new route declares access.** Every route sets `config: { access }` (`packages/api/src/lib/route-access.ts`): `public` (no key, and the route must be on `PUBLIC_ROUTES`), `admin`, `owner` (any key, the handler returns or changes only the caller's stored objects) or `key` (any key, nothing stored per key comes back). The server's `onRoute` hook throws at registration on a route with no declaration, on an unlisted `public` route, or on a declaration that contradicts the route's own `requireApiKey`/`requireAdmin`, and it runs the key check in `onRequest`, before schema validation. A route that stores something records `request.keyId` on it; reads go through `ownsOrAdmin` / `ownedOnly` (`lib/ownership.ts`), `ownedScan` (`lib/scan-access.ts`) or `scanHistoryKeyScope` (`plugins/auth.ts`). An object with no owner is admin-only. `packages/api/tests/tenancy-route-table.test.ts` enumerates every route, checks default-deny with no key and runs a two-key canary sweep; add a seed body there (`SEED_BODIES`) if a new `owner` creator needs one.

**Reopen checklist** (all before `FAULTLINE_CUSTOMER_KEYS=on`):
1. Two PASS seats on the tenancy change, and emma-soul's ruling.
2. The route-table test green on the deployed commit, with no route added since that lacks a seed or probe it needs.
3. Key revival (DONE, emma-soul ruling Dx3 e2909e46): `PATCH /keys/:id/enable`, `POST /keys/bulk-enable` and an `expiresAt` change on `PATCH /keys/:id` stay open, admin-only, and each writes an audit row `key revived: <id> (<how>)` (`tests/key-reopen-conditions.test.ts`).
4. Fleet counters (DONE, same ruling): `/health`, `/health/deep`, `/status.json` (and the `/status` page), `/queue/status` and `/notifications` keep their statuses for everyone and show counts (active keys, audit entries, scan volume, request counts, queue sizes, notification counts) only to a caller sending an admin key. A customer key gets the stripped view. Probe with no key to check.
5. Then set `FAULTLINE_CUSTOMER_KEYS=on` (Fly secret via `fly-ops.yml`), run the production two-key canary (A creates through every per-key route, B reads every per-key route and aggregate), revoke both keys, and post counts and the commit. Any cross-key result: set the flag off at once and tell emma-soul.

## Live probes (zero or near-zero spend)

- Auth header is `x-api-key: <key>`. `Authorization: Bearer` answers 401.
- Per-caller `/scan` cache (EP4 item 7): `POST /scan` with the server key, `x-faultline-user-ref: <8-128 of [A-Za-z0-9_-]>`, body `{"text":"<unique text>","provider":"mock"}`. Same ref twice → `X-Cache: MISS` then `HIT` with `cache:{hit:true,checkedAt}` in the body; another ref → MISS; no ref → never cached; `provider:"gemini"` → never cached (Google terms). Verified 2026-10-14 on 7e59280.

- Consensus gate: `POST https://faultline-api.fly.dev/scan/stream` with the server key, `x-user-tier: pro`, body `{"text":"…","provider":"mock","pipelineConfig":{"extractionProvider":"mock","consensus":true,"consensusProviders":["mock"]}}` → `403 consensus_not_in_plan`; `x-user-tier: enterprise` → 200.
- Spend cap state: `GET /usage` with the server key → `providerBudget.enforced` (false = dormant).
- Ledger health: `GET /usage` → `providerBudget.ledgerWriteFailures` and `groundingAllowance.ledgerWriteFailures` must be 0. Above 0 means the ledger file is not being written and the count lives only in memory.
- Gemini grounding allowance (N-230): `GET /usage` with the server key → `groundingAllowance` (`groundedPrompts` today, Pacific day, vs `alertThreshold` 1200 and `freeDailyLimit` 1500). The count restarts at 0 on every Fly deploy (no volume); `processStartedAt` shows when. Hourly cron on NXTG-AI: `/home/axw/.cache/faultline-pro/grounding-check-cron.sh`, log `/home/axw/.cache/faultline-pro/grounding-check.log`, rows in `~/ASIF/governance/spend-monitor/faultline-pro-grounding.jsonl`, Telegram once per day at 1,200 and past 1,500. Run it by hand: `node scripts/grounding-allowance-check.mjs` (exit 0 OK, 1 ALERT, 2 probe failure). Details: `docs/grounding-allowance-alert.md`.
- Web critique gate: `POST https://faultline.nxtg.ai/api/critique` with no `x-critique-token` → `401 critique_token_required`.
- Vercel runtime logs: free-text `query` times out on this project. Use `deploymentId` plus `statusCode`, `level: ["error"]` or `group_by` instead.

## Google prepay balance

The production Gemini key is in project Faultline (`gen-lang-client-0856465510`), billing account Personal Project (2026), `01D715-3F52D3-CC8E78`. Since 2026-10-12 that account is **prepay**: when the balance reaches $0, every API key on the account stops and every Faultline scan fails. The switch to prepay cannot be undone. No API returns the balance; read it in AI Studio, Billing tab (`https://aistudio.google.com/billing?billing=01D715-3F52D3-CC8E78`).

- Funding, drawn in this order: Google Developer Program promotional credits first ($60 applied 2026-10-13, $10 grants expiring 2027-02-23 to 2027-09-23, plus the founder's monthly $10 with "Always use this billing account" set), then prepay ($25 bought 2026-10-12, expires 2027-10-12). Google: "eligible Google Cloud credits are consumed before your Prepay credit balance."
- Alerts: Cloud Billing budget "Faultline prepay balance (25 USD credit)", Gemini API only, 2026-10-13 to 2027-10-12, net of credits, at $15 and $22 of $25 actual spend. It mails billing admins and the Monitoring email channel faultline.pro@nxtg.ai. Google records costs within about 24 hours, so an alert can lag spend by up to a day. `scripts/vendor-consent-watch.py` (cron every 15 minutes) labels mail to faultline.pro@ from a google.com sender as GOOGLE BILLING ALERT, mints P0 handoff `hf-fp-google-billing-<uid>`, wakes the fp pane, Telegrams and posts to /alignment.
- Google-side caps: a $20 per month project spend cap on Faultline (AI Studio, Spend; experimental) and the $250 billing-account tier cap. The project cap stops spend above $20 in a month whatever the balance.
- Auto-reload is **off**. Turning it on is emma-soul's call (al:4c0e56abe943a50c ruled it off pending her separate ruling).
- **Top-up path** when the alert fires:
  1. Read the balance in AI Studio Billing and the month's spend in AI Studio Spend. Post both.
  2. Buying credit is spend. The authorization record for the first purchase was emma-soul al:4c0e56abe943a50c ($25, hard ceiling $50, card already on file, no new payment method). A further purchase needs a new emma-soul authorization record naming the amount; the sending lane never authorizes itself. Ask emma-soul with the balance, the 30-day spend and the days left at that rate.
  3. On the record: AI Studio, Billing, Buy credits, "Other amount", the authorized amount, card on file, auto-reload left off, Continue. Google shows "Payment successful" and "Credits added".
  4. Receipt: balance before and after, then one production scan (`POST /scan`, admin key, provider gemini) that returns verdicts; append the purchase to `~/ASIF/governance/spend-ledger.jsonl` and post the receipt with the GoPMO node.
  5. If the $20 project cap, not the balance, is what stops scans, raising it is also emma-soul's call.

## Full scan (deep scan) jobs

- Routes and contract: `docs/design/2026-10-13-full-scan-api.md` (GoPMO 1.18.11.3.12). fw's meter charges and refunds; the API only reports units.
- Finished jobs: `/var/log/faultline/full-scan-jobs.jsonl` on the `faultline_ledgers` volume (`FAULTLINE_FULL_JOBS_LEDGER`). It holds ids, counts, units and reason codes, never text, claims or sources. Keep it that way: Google's grounding terms forbid caching grounded output.
- Limits: `FAULTLINE_FULL_MAX_RUNNING` (default 4 jobs at once), `FAULTLINE_FULL_ESTIMATE_PER_MIN` (default 10 estimates per key and user per minute).
- Refund rate: admin `GET /usage` -> `fullScanRefunds` (trailing 7 days); the hourly grounding check alerts fp on it and on any ledger write failure (`docs/grounding-allowance-alert.md`). When `alert` is true (refunded units above 10% of charged), find the cause from the reason-code totals and report it to emma-soul (ruling al:c747e63f2fc26683, condition 4).
- A deploy loses running jobs: fw sees `404 job_lost` and refunds them in full.
- `fullScanRefunds.admissionClosed: true` means a ledger write failed and new deep scans get `503 ledger_unavailable`. It reopens by itself once an 8 KB probe row can be written; fix the volume (space, mount), then post the affected job ids and units refunded within a day (emma-soul al:a1df02700e167833, condition 1).

## Revenue scoreboard timer (GoPMO 1.18.11.1.7)

- User timer `fp-scoreboard-read.timer` (`~/.config/systemd/user/`), 22:15 America/Chicago daily, before product-oracle's 22:30 CDT read (crontab). It runs `scripts/scoreboard-read.sh`: the Stripe oracle from git object `dcc3bff` (sha256 pinned in the script) piped into dx3's writer from `6536eb9`, `--lane fp`. Linger is on, so it runs without a login.
- Check: `systemctl --user list-timers fp-scoreboard-read.timer`, `journalctl --user -u fp-scoreboard-read.service`. Exit 0 = row read back equal; 1 = mismatch or API failure (re-send with the writer's `post --artifact <file>.post.json`); 2 = refused; 3 = the oracle failed and an all-unknown row was written.
- Artifacts (aggregate only, 0644): `~/.cache/faultline-pro/scoreboard/`. Rows: `GET http://127.0.0.1:8004/api/cognitive/ledger/entries?ledger=revenue&entry_kind=scoreboard`.
- First run 2026-10-13 17:13Z (manual start): row `22372e9f-1441-43c1-babd-e64a3836072c`, read back equal, 11 measures, 0 unknown.

## Founder UAT

Write the guide to `docs/uat/`, give the absolute path. For plan limits, seed Clerk metadata (public `plan`, private `scanUsage.{YYYY-MM}`) instead of running real scans, and tell the tester to keep the other private keys (`stripeCustomerId`, `stripeSubscriptionId`) and to restore the count afterwards.

## Security advisories (GitHub)

Precedent: GHSA-mxc3-4648-6p7x on nxtg-ai/faultline-action, published 2026-10-01.

1. Verify the facts first: the affected tag's commit, the fix commit is in the patched tag and not in the affected one (`git merge-base --is-ancestor`), and the exact vulnerable code at the affected tag.
2. Create a draft: `gh api -X POST repos/<owner>/<repo>/security-advisories --input <json>` with `summary`, `description`, `cvss_vector_string` (or `severity`), `cwe_ids`, `vulnerabilities[{package:{ecosystem,name}, vulnerable_version_range, patched_versions}]`. GitHub Actions use ecosystem `actions`, name `owner/repo`.
3. Wording: the vulnerability class, the impact, who is and is not affected, the upgrade step, a workaround. No payload, no step-by-step exploit, no em-dashes, no we/our. CE copy-reviews the text before publishing.
4. Publish: `gh api -X PATCH .../security-advisories/<GHSA> -f state=published`. Request a CVE: `gh api -X POST .../security-advisories/<GHSA>/cve` (returns `{}` when accepted; the CVE id appears later). Confirm the public page returns 200, then send CE the URL.
