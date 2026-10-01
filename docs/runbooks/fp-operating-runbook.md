# fp operating runbook

How the fp lane ships, deploys, releases and verifies Faultline. Read this before doing any of those things. Every item here was rediscovered at least once; if you learn a new one, add it here in the same change.

Last verified: 2026-10-01 (v0.11.0 release).

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
6. `gh release create vX.Y.Z --title vX.Y.Z --notes-file <the CHANGELOG section>`.
7. `gh workflow run publish.yml --ref vX.Y.Z`, then `gh run watch`.
8. Verify all four agree: `npm view @nxtg/faultline version`, `/health` version, tag, then `gh workflow run version-parity.yml` must pass.

Push quirk: the pre-push hook chain can print `failed to push some refs` and still let later `&&` steps run. After any push, check `git status -sb` shows no `[ahead N]`.

## Docs ship with the code

A change is not done until, in the same commit or PR: `CHANGELOG.md` `[Unreleased]` has it; affected READMEs and `llms.txt` are right; the NEXUS row status matches production; and, for a user-visible web change, faultline-web's public changelog `lib/changelog.ts` (page `/changelog`) has an entry. Before declaring anything shipped: `git log $(git describe --tags --abbrev=0)..HEAD` against `CHANGELOG.md`.

## Changing faultline-web (another lane's repo)

- Never touch `/home/axw/projects/faultline-web`'s working tree; fw works there. Use a worktree: `git -C /home/axw/projects/faultline-web worktree add <scratch>/fw-<topic> -b <branch> origin/main`.
- Customer-facing copy (pricing, changelog, FAQ, llms.txt, UI text) needs **CE copy review** (`@ce` on /alignment) before merge. CE rules: plain words, short sentences, no em-dashes in prose (colons or commas; em-dashes inside code fences are fine), no hype, no "we"-voice slogans.
- Security fixes get an adversarial review from **codex** (`@codex`) before merge; the author never grades its own fix.
- Merge with `gh pr merge <n> -R nxtg-ai/faultline-web --squash --match-head-commit <reviewed sha>`.
- After merge, verify on production, not in tests.

## Environment and secrets

- Server key for live engine probes: `FAULTLINE_API_KEY` in `/home/axw/projects/faultline-web/.env.local` (same value as `packages/api/.env`). Read it into a shell variable; never print it.
- faultline-web needs **unprefixed** `KV_REST_API_URL` and `KV_REST_API_TOKEN` (Upstash Redis via the Vercel Marketplace). A Vercel storage connection made with a custom prefix (it was `fp_kv_`) leaves them unset, and the rate limiters, anon quota and shared scans fail open. That was the state from at least 2026-05-18 until 2026-10-01 (the old store was also later uninstalled). fw restored it 2026-10-01 (faultline-web PR 52): store faultline-web-kv, no prefix, daily spend alert. **Before calling a cross-repo item open, read /alignment (`~/ASIF/governance/alignment/<date>.jsonl`) for the owning lane's posts; the owner may already have closed it.** fp's Vercel token gets 403 on env vars and integrations: Asif or fw change those.
- Git under conda: `env -u LD_LIBRARY_PATH PATH=/usr/bin:/bin /usr/bin/git`.

## Live probes (zero or near-zero spend)

- Consensus gate: `POST https://faultline-api.fly.dev/scan/stream` with the server key, `x-user-tier: pro`, body `{"text":"…","provider":"mock","pipelineConfig":{"extractionProvider":"mock","consensus":true,"consensusProviders":["mock"]}}` → `403 consensus_not_in_plan`; `x-user-tier: enterprise` → 200.
- Spend cap state: `GET /usage` with the server key → `providerBudget.enforced` (false = dormant).
- Ledger health: `GET /usage` → `providerBudget.ledgerWriteFailures` and `groundingAllowance.ledgerWriteFailures` must be 0. Above 0 means the ledger file is not being written and the count lives only in memory.
- Gemini grounding allowance (N-230): `GET /usage` with the server key → `groundingAllowance` (`groundedPrompts` today, Pacific day, vs `alertThreshold` 1200 and `freeDailyLimit` 1500). The count restarts at 0 on every Fly deploy (no volume); `processStartedAt` shows when. Hourly cron on NXTG-AI: `/home/axw/.cache/faultline-pro/grounding-check-cron.sh`, log `/home/axw/.cache/faultline-pro/grounding-check.log`, rows in `~/ASIF/governance/spend-monitor/faultline-pro-grounding.jsonl`, Telegram once per day at 1,200 and past 1,500. Run it by hand: `node scripts/grounding-allowance-check.mjs` (exit 0 OK, 1 ALERT, 2 probe failure). Details: `docs/grounding-allowance-alert.md`.
- Web critique gate: `POST https://faultline.nxtg.ai/api/critique` with no `x-critique-token` → `401 critique_token_required`.
- Vercel runtime logs: free-text `query` times out on this project. Use `deploymentId` plus `statusCode`, `level: ["error"]` or `group_by` instead.

## Founder UAT

Write the guide to `docs/uat/`, give the absolute path. For plan limits, seed Clerk metadata (public `plan`, private `scanUsage.{YYYY-MM}`) instead of running real scans, and tell the tester to keep the other private keys (`stripeCustomerId`, `stripeSubscriptionId`) and to restore the count afterwards.

## Security advisories (GitHub)

Precedent: GHSA-mxc3-4648-6p7x on nxtg-ai/faultline-action, published 2026-10-01.

1. Verify the facts first: the affected tag's commit, the fix commit is in the patched tag and not in the affected one (`git merge-base --is-ancestor`), and the exact vulnerable code at the affected tag.
2. Create a draft: `gh api -X POST repos/<owner>/<repo>/security-advisories --input <json>` with `summary`, `description`, `cvss_vector_string` (or `severity`), `cwe_ids`, `vulnerabilities[{package:{ecosystem,name}, vulnerable_version_range, patched_versions}]`. GitHub Actions use ecosystem `actions`, name `owner/repo`.
3. Wording: the vulnerability class, the impact, who is and is not affected, the upgrade step, a workaround. No payload, no step-by-step exploit, no em-dashes, no we/our. CE copy-reviews the text before publishing.
4. Publish: `gh api -X PATCH .../security-advisories/<GHSA> -f state=published`. Request a CVE: `gh api -X POST .../security-advisories/<GHSA>/cve` (returns `{}` when accepted; the CVE id appears later). Confirm the public page returns 200, then send CE the URL.
