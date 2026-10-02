# Security evidence: engine and API at v0.11.1 (2026-10-02)

GoPMO 1.18.7.3.6. Sections 1–7 are the evidence as collected at ~20:00 UTC, before any change. Section 0 is the disposition of every High and Critical after the fixes made the same day.

| Field | Value |
|---|---|
| Collected | 2026-10-02, ~19:55–20:06 UTC |
| Tree scanned | `0aaeb2f` (main). `git diff --stat 04ba8fe HEAD` shows only `.asif/NEXUS.md` (1 line) changed since the v0.11.1 release commit `04ba8fe`, so the code is v0.11.1 |
| npm | 11.6.0 (`npm --version`) |
| Install state | No `node_modules` in the scanning worktree. `npm audit` and `npm ls --package-lock-only` read `package-lock.json` only |
| What ships where | Fly API image: root `Dockerfile:45` runs `npm ci --omit=dev` from the root lockfile, so the `--omit=dev` audit set is what runs on `faultline-api`. npm CLI (`@nxtg/faultline`): the repo lockfile does not ship; `npm i @nxtg/faultline` resolves its semver ranges fresh, so a lockfile finding on a CLI dependency means "pinned in our lockfile", not "on every user's machine" |

Every number below sits next to the command that produced it.

---

## 0. Dispositions: every High and Critical (2026-10-02, after fixes)

Format from `~/ASIF/standards/gate-evidence-security.md`: every item is **fixed**, **accepted** or **mitigated**, with the reason for any deferral. Each row names its instrument.

### Dependencies

| Source | Instrument (re-run) | critical | high | Disposition |
|---|---|---|---|---|
| npm audit, production (`--omit=dev`, what the Fly image installs) | `npm audit --omit=dev` at `c552401` | 0 | 0 | **fixed**: adm-zip 0.6.1, fast-uri ^3.1.8 (override raised), @fastify/static 10.1.5 via @fastify/swagger-ui 6, fastify 5.12.5, js-yaml / protobufjs / ws / brace-expansion in range (`ecb507f`, `43a4129`). The CI job `npm audit` in `security-scan.yml` now fails on any unaccepted high or critical (`security/accepted-advisories.json` is `[]`) |
| Dependabot, open | `gh api repos/nxtg-ai/faultline-pro/dependabot/alerts?state=open` (high/critical filter) | 0 | 4 | **accepted**: browserslist, nanoid, postcss, vite, all `scope: development` in `package-lock.json`. They are build tooling for `packages/web` (the Kaggle-era Vite app). The Fly image runs `npm ci --omit=dev`, so none of them is installed in production, and the npm CLI package does not depend on them. Review when `packages/web` is next built for release |

### Named items (dx3-pm, al:1c79898f4d631cd1)

| Item | Disposition | Instrument |
|---|---|---|
| adm-zip (customer ZIPs on `/scan/bulk`, any key) | **fixed**, 0.5.17 → 0.6.1 | `ecb507f`; 135 bulk and GDPR-export tests pass; image builds and serves |
| fast-uri pinned by the root override | **fixed**, override 3.1.2 → ^3.1.8; top-level resolves 3.1.8, fastify's own copy 4.2.1 | `ecb507f`; `npm audit --omit=dev` shows no fast-uri advisory |
| DNS rebinding on the SSRF guard | **fixed**: guarded requests run on undici with a connect-time lookup that refuses any private address, so the address checked is the address connected | `9212a26`; 7 rebinding tests on real sockets; mutation: connect-time check removed → 4 fail |
| Admin-only SSRF in provider plugins (CodeQL #4) | **fixed**: endpoint refused at `POST /providers/register` (400) and every plugin call goes through the guard, no redirects | `9212a26`; 6 tests |
| faultline-action GHSA-mxc3-4648-6p7x | **fixed**: the advisory lists vulnerable `= 1.0.0`, patched `1.1.0` (`gh api repos/nxtg-ai/faultline-action/security-advisories`). `v1.1.0` is an ancestor of `v1.1.1` (`git merge-base --is-ancestor`), and `v1` resolves to `v1.1.1` (`f41f650`). Every `inputs.*` in `action.yml` sits in an `env:` or `with:` block, none inside a `run:` script. No CVE assigned yet | as listed |
| `security-scan.yml` could not fail | **fixed**: ratchet gate, §8. Red run 37065802290 (planted finding), green run 37066020388 | PR #59, merged `c552401` |

### Code scanning (CodeQL), open High and Critical

Before: 2 critical, 13 high (`gh api .../code-scanning/alerts?state=open`). Each was opened at its line before a disposition was recorded. Dismissals are recorded in GitHub with the reason.

| Alert | Disposition |
|---|---|
| #5 SSRF `/webhooks/test` (critical) | **fixed** `743e855`, live-probed |
| #4 SSRF provider plugins (critical) | **fixed** `9212a26` |
| #6 regex injection, #7 polynomial ReDoS (`store/rules.ts`) | **fixed** `37e6360`: pattern safety check at create and at PATCH (the PATCH path had no check), 256-char cap, text cap, 1 s evaluation budget; mutation-checked |
| #8 resource exhaustion (`pdf-report.ts`) | **fixed** `37e6360`: importance clamped to 1..5 |
| #2 dynamic method call (`providers/registry.ts`) | **fixed** `37e6360`: factories are a `Map` |
| #62, #63, #64, #65 (re-raised on the fixed code) | **dismissed, false positive**: CodeQL does not recognise our sanitisers. #62 is the guard itself; #63/#64 compile a pattern only after the safety check or only to validate syntax; #65 is after the clamp |
| #9 clear-text logging (`cli/index.ts:1446`) | **dismissed, won't fix**: the CLI prints command output to the user's own terminal by design |
| #3 incomplete sanitisation (`providers/wikipedia.ts:41`) | **dismissed, false positive**: tags are stripped only to lowercase-match words; never rendered |
| #53–#58 (`scripts/measure-consensus-cost.ts`, `scripts/consensus-cost/capture.ts`) | **dismissed, won't fix**: developer measurement scripts, not in the API image or the npm package |
| #59 (`tests/consensus-usage-e2e.test.ts`) | **dismissed, used in tests** |

### Found during the fixes (not in the scanners' High list)

| Item | Disposition |
|---|---|
| SSRF in scheduled URL scans (body read back to the caller) | **fixed** `3ef0ecd`, live-probed |
| Custom rules shared across every API key (any key could read, change, delete or apply another's) | **fixed** `d2cae2e`: rules are private to the creating key; 6 tests, mutation-checked |
| Scan history readable across API keys, and stored XSS in `/scans/stale/view` (Bearer) | **in progress**: see the last section of this doc when it lands |
| `lib/url-validator.ts` HEAD probes to model-returned source URLs | **mitigated, accepted for beta**: the request returns only a status code to the scan (no body), it targets URLs a model cited, and prompt injection steering it gains a blind reachability probe at most. Route it through the guard when the url-validator is next changed |

---

## 1. npm audit (root, covers all workspaces)

| Scope | Command | critical | high | moderate | low | total |
|---|---|---|---|---|---|---|
| All (dev + prod) | `npm audit --json \| jq -c .metadata.vulnerabilities` | 0 | 17 | 10 | 2 | **29** |
| Production only | `npm audit --omit=dev --json \| jq -c .metadata.vulnerabilities` | 0 | 10 | 6 | 1 | **17** |

Counts are **packages**, not advisories. One package can carry many advisories (for example `protobufjs` carries 11).

### High-severity packages in the production set (`--omit=dev`)

Workspace = output of `npm ls <pkg> --omit=dev --package-lock-only --all`. Fix = `fixAvailable` in `npm audit --omit=dev --json`.

| Package @ locked version | Advisories (high unless noted) | Pulled in by | Fix available |
|---|---|---|---|
| `fastify` 5.8.5 (direct) | GHSA-p68q-wchp-6fh7 (auth bypass via malformed URL), GHSA-667r-xxjv-c9mm, GHSA-hwr6-493r-vm6h, GHSA-9q9j-q6p8-xq58; moderate: GHSA-w2qp-rph6-63g4, GHSA-3m5p-2c4r-xxw2, GHSA-4mh8-r7rc-xpvc | `packages/api` (direct) | Yes, in range (>=5.12.5). Dependabot PR #57 open |
| `find-my-way` 9.5.0 | GHSA-c96f-x56v-gq3h (HTTP/2 DoS) | `packages/api` via `fastify` | Yes (with fastify) |
| `adm-zip` 0.5.17 (direct) | GHSA-xcpc-8h2w-3j85, GHSA-7q85-xj36-vmfc, GHSA-rcw4-f5rp-g42v, GHSA-j5f4-cc29-5x44, GHSA-8238-w5pm-2374; moderate: GHSA-vwc7-r8mq-g2x9, GHSA-p634-w6r4-rjp2, GHSA-c6fg-446q-cg94 | `packages/api` (direct) | Yes, semver-major (0.6.1). Dependabot PR #54 open since 2026-09-19 |
| `fast-uri` 3.1.2 | GHSA-v2hh-gcrm-f6hx, GHSA-7p8r-x3mc-p8w7, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp, GHSA-4c8g-83qw-93j6, GHSA-qw65-cvwx-89v3; moderate: GHSA-hrr3-gc8f-f4qj | `packages/api` (fastify, @fastify/swagger, mercurius) and root `@google/genai` → `@modelcontextprotocol/sdk` → `ajv` | Upstream yes (>=3.1.8), **but blocked in this repo**: root `package.json:58` has `"overrides": { "fast-uri": "3.1.2" }`, which pins the vulnerable version. `npm ls fast-uri` reports `ELSPROBLEMS invalid` because of that override |
| `ajv` 8.18.0 | none of its own; high only through `fast-uri` | `packages/api` (fastify, mercurius), root `@google/genai` | Yes (via fast-uri) |
| `@fastify/static` 9.1.1 | GHSA-83w8-p2f5-377r (route guard bypass via path traversal); moderate: GHSA-8pvw-jcv7-9cmj | `packages/api` via `@fastify/swagger-ui` 5.2.5 and `mercurius` 16.9.0 | Yes, semver-major (`@fastify/swagger-ui` 6.1.1) |
| `brace-expansion` 5.0.5 | GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p (DoS) | `packages/api` via `@fastify/swagger-ui` → `@fastify/static` → `glob` → `minimatch` | Yes |
| `js-yaml` 4.1.1 (direct) | GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh (quadratic CPU); moderate: GHSA-h67p-54hq-rp68 | root and `packages/cli` (direct) | Yes (>=4.3.2). Dependabot PR #53 open since 2026-09-13 |
| `protobufjs` 7.5.5 | GHSA-66ff-xgx4-vchm (code injection via bytes defaults), GHSA-75px-5xx7-5xc7, GHSA-jvwf-75h9-cwgg, GHSA-685m-2w69-288q, GHSA-wcpc-wj8m-hjx6; 6 moderate | root and `packages/cli` via `@google/genai` 1.50.1 | Yes |
| `ws` 8.20.0 | GHSA-96hv-2xvq-fx4p (memory DoS); moderate: GHSA-58qx-3vcg-4xpx | root via `@google/genai`; `packages/api` via `mercurius` / `@fastify/websocket` | Yes |

`@fastify/swagger-ui` and `mercurius` appear in the audit as moderate only because they depend on `@fastify/static`.

Reachability notes (from reading code, not exploited):
- `adm-zip` parses **customer-uploaded ZIPs**: `packages/api/src/routes/bulk.ts:25` and `:90` (`new AdmZip(zipBuffer)`), behind `requireApiKey` (`bulk.ts:60`). The memory-exhaustion advisories are reachable by any key holder.
- `fastify` GHSA-3m5p-2c4r-xxw2 (X-Forwarded spoofing) needs `trustProxy`; `grep -n trustProxy packages/api/src/server.ts` returns nothing, so that one does not apply.

### Dev-only highs (in the 29, not the 17)
`@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `browserslist`, `nanoid`, `postcss`, `undici`, `vite` (from `npm audit --json`, packages absent from the `--omit=dev` set). None run in the Fly image.

---

## 2. Dependabot

| Measure | Command | Value |
|---|---|---|
| Open alerts | `gh api repos/nxtg-ai/faultline-pro/dependabot/alerts --paginate \| jq -s '[add[]\|select(.state=="open")]\|length'` | **101** |
| By severity | same, `group_by(.security_advisory.severity)` | high **45**, medium **48**, low **8**, critical 0 |
| By manifest + scope | same, grouped on `.dependency.manifest_path + " " + .dependency.scope` | `package-lock.json` runtime **66**; `package-lock.json` development **27**; `packages/api/package.json` runtime **8** |
| Open Dependabot PRs | `gh pr list -R nxtg-ai/faultline-pro --author app/dependabot --state open` | **11** (#47–#57, oldest opened 2026-09-03) |

This matches the push message on 2026-10-02: "101 vulnerabilities (45 high, 48 moderate, 8 low)".

Dependabot counts one alert per advisory per manifest. npm audit counts packages. So 101 and 29 measure different things; they do not contradict each other. The 8 alerts on `packages/api/package.json` are the same 8 `adm-zip` advisories also counted against `package-lock.json`.

### Triage: ships or not

Every open alert sits on the root `package-lock.json` or `packages/api/package.json`. There are **0** alerts on `packages/web`, `packages/terraform-provider` (Go), or `sdks/python` manifests (none appear in the manifest grouping above). The manifest path alone cannot split cli, api and web, because every workspace resolves through the root lockfile. The split below combines Dependabot `scope` with the `npm ls` traces from section 1.

| Bucket | Alerts | Packages | Ships? |
|---|---|---|---|
| Runtime, API image | 66 lockfile + 8 api manifest = 74 | fastify (7), find-my-way (1), adm-zip (8 + 8), fast-uri (8), @fastify/static (2), brace-expansion (7), ws (2), js-yaml (4), protobufjs (11), @protobufjs/utf8 (1), hono (8), ip-address (4), qs (2), esbuild (1, low; `npm ls esbuild --omit=dev --package-lock-only` → root `tsx@4.21.0` → `esbuild@0.27.7`) | Yes. Fly runs `npm ci --omit=dev` (`Dockerfile:45`). js-yaml, protobufjs and ws also resolve for CLI users from their own install |
| Development | 27 | undici (17), vite (2), vitest (1), @vitest/mocker (1), postcss (2), nanoid (1), browserslist (1), baseline-browser-mapping (1), @babel/core (1) | No. Test, build and mutation tooling only |

Package counts come from `gh api repos/nxtg-ai/faultline-pro/dependabot/alerts --paginate | jq -s -c '[add[]|select(.state=="open" and .dependency.manifest_path=="package-lock.json")]|map(.dependency.scope+":"+.dependency.package.name)|group_by(.)|map({(.[0]):length})|add'`.

---

## 3. GHSA-mxc3-4648-6p7x re-check

| Check | Command | Result |
|---|---|---|
| Global advisory DB | `gh api /advisories/GHSA-mxc3-4648-6p7x` | **HTTP 404**. Not in the global (reviewed) advisory database |
| Repo advisory | `gh api repos/nxtg-ai/faultline-action/security-advisories/GHSA-mxc3-4648-6p7x` | state `published` 2026-10-01T21:32:29Z, severity high, CVSS 3.1 7.7 (`AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:L`), CWE-78 and CWE-94 |
| CVE | same call, `.cve_id` | **null**. No CVE assigned as of 2026-10-02 ~20:00 UTC |
| Affected package | same call, `.vulnerabilities` | ecosystem `actions`, `nxtg-ai/faultline-action`, vulnerable `= 1.0.0`, patched `1.1.0` |
| Are we affected (this repo)? | `grep -rn faultline-action .github/` | **No.** No workflow in faultline-pro uses the action |
| Do our docs point users at a safe tag? | `git grep -n "faultline-action@"` → `README.md:431`, `packages/cli/README.md:151`, `llms.txt:43` all say `@v1`. `gh api repos/nxtg-ai/faultline-action/commits/v1 -q .sha` and `.../commits/v1.1.1 -q .sha` | Both resolve to `f41f650`. The floating `v1` tag points at the patched v1.1.1, so users following our docs get the fix. Only users pinned to `@v1.0.0` remain exposed |

---

## 4. CI security scanning

### `.github/workflows/security-scan.yml`
Triggers: `push` and `pull_request` on main/master. There is **no `workflow_dispatch`**. It runs four jobs:
- Semgrep (`semgrep scan --config auto`)
- Bandit (Python)
- Bearer (data privacy)
- Gitleaks `detect` over full history

**The workflow cannot fail on findings.** Semgrep runs with `|| true`, Bandit with `--exit-zero ... || true`, Bearer with `continue-on-error: true`, and Gitleaks with `--exit-code 0`. The SARIF goes to run **artifacts** only and is not uploaded to code scanning.

| Measure | Command | Value |
|---|---|---|
| Latest run after 04ba8fe | `gh run list -R nxtg-ai/faultline-pro --workflow security-scan.yml --limit 5` | run **37054437598**, head `0aaeb2f`, push, conclusion **success** (2026-10-02T19:29Z). Runs on `80b4c23` (37052655252) and `04ba8fe` (37052252814) also show success |
| Semgrep findings | `gh run view 37054437598 --log` → `Ran 696 rules on 371 files: 74 findings.` | **74**. By rule (SARIF artifact): github-actions-mutable-action-tag 33, direct-response-write 15, unsafe-formatstring 9, detect-non-literal-regexp 6, raw-html-format 5, gha-curl-pipe-shell 2, run-shell-injection 1, detect-insecure-websocket 1, missing-integrity 1, dynamic-urllib-use 1. By area: .github 32, packages/api 24, packages/cli 12 |
| Gitleaks (history) | same log → `1256 commits scanned.` / `leaks found: 33` | **33** over history: curl-auth-header 28, generic-api-key 3, stripe-access-token 2 |
| Bearer | `gh run download 37054437598` → `bearer.sarif` results | **96**: logger_leak 78, manual_html_sanitization 4, raw_html_using_user_input 4, insufficiently_random_values 3, hardcoded_secret 2, dangerous_insert_html 2, other 3 |
| Bandit | `bandit.sarif` results | **301**, all in `sdks/python`, 300 at level `note` (B101 assert 252, B110 33, B105 14) |

"success" on this workflow is unconditional, so it is not evidence of a clean scan.

### Code scanning (CodeQL)
Code scanning **is enabled**. CodeQL runs through GitHub default setup, not a workflow file: `gh api repos/nxtg-ai/faultline-pro/code-scanning/default-setup` → `state: configured`, languages actions, go, javascript-typescript, python.

| Measure | Command | Value |
|---|---|---|
| Latest analyses | `gh api repos/nxtg-ai/faultline-pro/code-scanning/analyses?per_page=8` | 4 analyses on `0aaeb2f` at 2026-10-02T19:30Z: javascript-typescript **15** results, go 0, python 0, actions 0 |
| Open alerts, all tools | `gh api "repos/nxtg-ai/faultline-pro/code-scanning/alerts?per_page=100&state=open" --paginate -q '.[].number' \| wc -l` | **58** |
| By tool and severity | same, `-q '.[]\|.tool.name+" "+(.rule.security_severity_level // .rule.severity)' \| sort \| uniq -c` | CodeQL critical **2**, CodeQL high **13**, Semgrep OSS 32 (1 error, 26 warning, 5 note), Gitleaks 9, Faultline 2 |

The task's literal command `gh api .../code-scanning/alerts -q 'length'` returns **30**. That is the first page only (default page size 30) with no state filter, so it is not the open count. Across all pages, `gh api "repos/nxtg-ai/faultline-pro/code-scanning/alerts?per_page=100" --paginate -q '.[].state' | sort | uniq -c` gives 58 open and 1 fixed.

Only the 15 CodeQL alerts are current (re-analysed on `0aaeb2f`). The 32 Semgrep OSS, 9 Gitleaks and 2 Faultline alerts were created 2026-04-13/15 by an older upload path. `security-scan.yml` no longer uploads SARIF, so those 43 alerts are stale and never auto-close.

CodeQL critical and high alerts on product code:

| # | Rule | Location | Note |
|---|---|---|---|
| 5 | js/request-forgery (critical) | `packages/api/src/store/webhooks.ts:429` | Sink for `POST /webhooks/test`, which needs only a normal API key. See section 6 |
| 4 | js/request-forgery (critical) | `packages/api/src/store/providers.ts:92` | Reachable only through `POST /providers/register`, which is `requireAdmin` (`routes/providers.ts:40` after the fix). **FIXED 2026-10-02**, see "Fix: outbound URL guard", "Same class" |
| 6, 7 | js/regex-injection, js/polynomial-redos | `packages/api/src/store/rules.ts:88`, `:132` | User-defined rule patterns compiled to RegExp |
| 8 | js/resource-exhaustion | `packages/api/src/store/pdf-report.ts:84` | |
| 9 | js/clear-text-logging | `packages/cli/cli/index.ts:1446` | |
| 3 | js/incomplete-multi-character-sanitization | `packages/api/src/providers/wikipedia.ts:41` | |
| 2 | js/unvalidated-dynamic-method-call | `packages/cli/providers/registry.ts:35` | |
| 53–59 | js/incomplete-url-substring-sanitization | `scripts/` (6) and `packages/api/tests/` (1) | Not shipped code |

---

## 5. Secrets scan of the tracked tree

Before scanning, `git status --porcelain --ignored` printed nothing, so the scanned directory is exactly the tracked tree.

| Scan | Command | Hits |
|---|---|---|
| Gitleaks 8.28.0, tree | `gitleaks dir . --redact --no-banner --report-format json --exit-code 0` | **18** |
| Pattern grep | `git grep -cE 'AKIA[0-9A-Z]{16}\|sk-[A-Za-z0-9_-]{20,}\|sk-ant-…\|AIza[0-9A-Za-z_-]{35}\|ghp_[A-Za-z0-9]{36}\|github_pat_…\|-----BEGIN [A-Z ]*PRIVATE KEY-----\|sk_live_…\|fl_live_…'` | **5** lines in 3 files |

Hits by file (values never printed; each was classified from redacted output):

| File:line | Rule | Classification |
|---|---|---|
| `docs/uat/asif-uat-eu-ai-act-compliance-layer-v1.0.0.md` (11 lines: 62–172) | curl-auth-header | **Placeholder.** A 12-character lowercase word pair, the same string the doc uses to start a local server (`FAULTLINE_API_KEY=<same> npm start`, line 28). Local-only |
| `README.md:240`, `:249`; `docs/plugins/tutorial.md:236`, `:277` | curl-auth-header | Example curl commands with placeholder headers |
| `sdks/python/tests/test_client.py:119`, `:240` | generic-api-key | Test fixture key for the SDK client tests |
| `packages/cli/tests/yaml-engine.test.ts:499`, `:506`, `:527` | stripe-access-token, AKIA, BEGIN PRIVATE KEY | **Detection-rule test fixtures** (`it('should load and detect API keys')`). The Stripe-shaped string is 24 characters, shorter than any issued Stripe secret key |
| `packages/terraform-provider/README.md:73` | fl_live_ pattern | Placeholder: one repeated character after the prefix |
| `docs/REVENUE-RESEARCH.md:85` | sk- pattern | False positive: a URL slug |

Result: **0 live secrets** found in the tracked tree. The history scan in CI (section 4) reports 33. Two of those are in paths no longer in the tree (`packages/sdk/tests/client.test.ts`, root `tests/yaml-engine.test.ts`); the rest are the same files listed above. History was not re-classified line by line in this task.

---

## 6. API surface (code read only, nothing changed)

- **Auth** (`packages/api/src/plugins/auth.ts:23-51`): `requireApiKey` accepts the server's `FAULTLINE_API_KEY` (keyId `admin`) or a keystore key. The comparison is constant-time (`safeEqual` with `timingSafeEqual`, `:7-10`). It returns 503 if no key is configured and 401 if the key is missing or wrong. `requireAdmin` (`:57-89`) returns 403 unless the caller holds the env key or a keystore key with the `admin` permission.
- **Rate limit** (`plugins/ratelimit.ts:20-48`, tiers in `store/ratelimit.ts:4-6`): per-key, per-minute limits of free 10, pro 100, admin 10,000. Exceeding the limit returns 429 with X-RateLimit headers. Counters are an in-process `Map` (`store/ratelimit.ts:33`), so each Fly machine counts separately. All faultline-web traffic arrives on the single admin key, so per-user limits for web users are not enforced at this layer (lead, not tested).
- **x-user-tier trust rule** (`plugins/consensus-entitlement.ts:30-35`): the header is honoured only for keyId `admin`. An unknown value fails closed to `free`, and keystore keys ignore the header. `enforceConsensusEntitlement` (`:48-60`) refuses consensus with 403 for non-Enterprise callers and never silently downgrades. It runs on `POST /scan/stream` (`routes/stream.ts:215`). The GET variant (`:102`) takes no `pipelineConfig`, so it has no consensus path.
- **CORS and security headers on SSE** (`routes/stream.ts:63-80`, used at `:132` and `:239`): `reply.hijack()` skips the `onSend` hook (`server.ts:111-119`). `sseHeaders()` copies the reply's existing headers (CORS) onto `writeHead` and re-adds nosniff, `X-Frame-Options: DENY`, `Referrer-Policy`, and `CSP default-src 'none'`. CORS (`server.ts:96-101`) allows `https://*.nxtg.ai` and localhost. Requests with no Origin header get no CORS grant in production.
- **SSRF surface** (`routes/webhooks.ts:78-104`): `POST /webhooks/test` is guarded by `requireApiKey` only (not admin). Its only URL check is `new URL(url)` (`:101`). It then POSTs to that URL from the server (`store/webhooks.ts:429`) and returns status code, status text and latency. There is no block on private, loopback or link-local addresses.

---

## 7. Findings and actions (ranked, red first)

1. **FIXED 2026-10-02 (`743e855`, live-probed below): SSRF reachable by any API key holder.** `POST /webhooks/test` (`routes/webhooks.ts:82`) needs only `requireApiKey`, accepts any URL that parses, and returns status code and latency. That makes it a probe of Fly's internal network. This is CodeQL alert #5 (critical). Action: require admin, or resolve the host and refuse private, loopback, link-local and Fly `.internal` addresses before the fetch. Re-check `/webhooks/test/:id` and registered-webhook delivery the same way. Not live-probed in this task.
2. **FIXED 2026-10-02 (fastify 5.12.5, applied on main in place of PR #57): fastify 5.8.5 on the live API.** It carries an auth-bypass advisory (GHSA-p68q-wchp-6fh7) plus 3 more high validation and header-bypass advisories. Fix is in range (5.12.5). Action: merge Dependabot PR #57 after CI passes.
3. **RED: adm-zip 0.5.17 parses customer ZIPs.** Upload path is `routes/bulk.ts:25`, `:90`, behind `requireApiKey`. It carries 5 high decompression and memory advisories. Action: PR #54 (0.6.1, semver-major) plus a test on the bulk route.
4. **RED: the `fast-uri` override pins a vulnerable version.** Root `package.json:58` sets `"fast-uri": "3.1.2"`, which has 7 high advisories (SSRF and host confusion). `npm audit fix` and Dependabot cannot move it while the override stands. Action: raise the override to >=3.1.8 or remove it.
5. **RED, fix in PR #59 (not merged): security-scan.yml is green regardless of findings.** See §8 for the ratchet. Every scanner is `|| true`, `--exit-zero`, `continue-on-error` or `--exit-code 0`. Run 37054437598 is "success" with Semgrep 74, Gitleaks 33, Bearer 96 and Bandit 301 findings. Action: fail on high-severity Semgrep and on new Gitleaks hits, and add `workflow_dispatch`.
6. **AMBER: 101 open Dependabot alerts and 11 open Dependabot PRs**, the oldest from 2026-09-03; 74 alerts are runtime-scope. Production npm audit: 10 high and 6 moderate packages. Other runtime highs: js-yaml (PR #53), protobufjs and ws via `@google/genai`, `@fastify/static` via swagger-ui (semver-major), and brace-expansion.
7. **AMBER: 2 CodeQL critical and 13 high alerts open.** Beyond #5: #4 is admin-only SSRF, #6/#7 are regex injection and ReDoS on user rule patterns (`store/rules.ts`), #8 is resource exhaustion in `pdf-report.ts`, and #9 is clear-text logging in `cli/index.ts:1446`.
8. **AMBER: 43 stale code-scanning alerts** from Semgrep, Gitleaks and Faultline uploads (2026-04). They never auto-close because the workflow no longer uploads. Action: dismiss them, or re-enable SARIF upload so they track reality.
9. **GREEN: GHSA-mxc3-4648-6p7x.** No CVE assigned yet (`cve_id` null). faultline-pro does not use the action, and `@v1` resolves to the patched v1.1.1 (`f41f650`).
10. **GREEN: secrets.** 0 live secrets in the tracked tree. The 18 tree hits are placeholders and detection-test fixtures. Optional: add a `.gitleaksignore` for the fixtures so the history count means something.

Not done in the audit above, by scope: no dependency upgrades, no source edits, and no live probes against `faultline-api.fly.dev`.

---

## Fix: outbound URL guard (CodeQL #5)

Branch `fix/outbound-url-ssrf`, not deployed. Closes finding 1 in section 7.

**The guard.** `packages/api/src/lib/outbound-url.ts`. `assertSafeOutboundUrl` (`:179`) refuses, with `OutboundUrlBlockedError`: a URL that does not parse; any scheme other than http and https; embedded credentials; the names `localhost`, `internal`, `flycast`, `local` and any subdomain of them (trailing dot stripped); and any address in 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, 255.255.255.255, `::`, `::1`, `::ffff:0:0/96`, `64:ff9b::/96`, fc00::/7 (covers Fly 6PN `fdaa::/16`), fe80::/10 and ff00::/8 (`:47-76`). An IP literal is checked directly. A name is resolved with `dns.promises.lookup(host, { all: true })` (`:33`) and is refused if ANY answer is private. IPv4-mapped and NAT64 IPv6 are refused as whole ranges, so a public IPv4 written as `::ffff:a.b.c.d` is refused too; the plain IPv4 form works. IPv4 and IPv6 use separate `BlockList`s because Node's `BlockList` also tests an IPv4 address against IPv6 rules in its `::ffff:` form: one shared list refused every IPv4 address. The range-edge tests caught that before commit.

**Every sink, checked at registration and again at send.** `fetchOutbound` (`:209-212`) runs the guard and then calls fetch with `redirect: 'manual'`, so a 3xx is recorded as the status and the Location is never requested.

| Sink | Send-time guard | Registration 400 |
|---|---|---|
| `POST /webhooks/test` | `store/webhooks.ts:436` | `routes/webhooks.ts:105` |
| `POST /webhooks/test/:id` | `store/webhooks.ts:436` | via `POST /webhooks` |
| Registered webhook delivery | `store/webhooks.ts:290`, per attempt; a refusal is not retried | `routes/webhooks.ts:40` |
| Job `webhookUrl` | `store/jobs.ts:148` | `routes/jobs.ts:35` |
| Notification `webhookUrl` and `FAULTLINE_NOTIFY_WEBHOOK` | `store/notifications.ts:207` | `routes/notifications.ts:130` |
| `FAULTLINE_ALERT_WEBHOOK` (operator env) | `store/rate-alerts.ts:71` | n/a |

The two operator env URLs are guarded too, so an operator cannot point alerts at a private host.

**No read-back.** `sendTestWebhook` no longer returns the target's body or headers. `responseBody` is always `null` and `responseHeaders` always `{}`, so the response shape is unchanged. The HTML tester shows the status and the sent payload only.

**Test escape hatch.** `FAULTLINE_OUTBOUND_ALLOW_PRIVATE=1` skips the name and address checks (scheme and credentials are still enforced), and only when `NODE_ENV=test` or `VITEST` is set (`:129`). `packages/api/vitest.config.ts` sets it for the existing suites, which use fake hosts and loopback servers. The guard's own tests remove it.

**Tests.** `packages/api/tests/outbound-url.test.ts` covers each range with edges on both sides, IPv4-mapped in dotted and hex form, NAT64, names, schemes, credentials, mixed DNS answers, resolver failure, and the override's production refusal. All DNS goes through an injected resolver. `packages/api/tests/outbound-url-sinks.test.ts` covers the registration 400s, send-time refusal with no fetch at every sink, and real loopback servers proving a 302 is not followed and the body and headers are not returned. Non-hollow check: with the guard removed at `store/webhooks.ts:290`, 3 tests failed. With `redirect: 'manual'` removed, 6 failed. Both were restored.

### Live probe after deploy (2026-10-02 20:30Z)

Deployed as `743e855` (fly-deploy run 37060898078). `POST https://faultline-api.fly.dev/webhooks/test` with the admin key:

| Target | Response |
|---|---|
| `http://169.254.169.254/latest/meta-data/` | `{"error":"Outbound URL blocked: host 169.254.169.254 resolves to a private or reserved address (169.254.169.254)"}` |
| `http://127.0.0.1:3000/health` | `{"error":"Outbound URL blocked: host 127.0.0.1 resolves to a private or reserved address (127.0.0.1)"}` |
| `http://[fdaa::3]/` (Fly private network) | `{"error":"Outbound URL blocked: host fdaa::3 resolves to a private or reserved address (fdaa::3)"}` |
| `https://example.com/` (control) | sent, `statusCode` returned, no body |

### DNS rebinding: closed (2026-10-02, branch `fix/ssrf-rebinding`)

Before: the guard resolved the name, then Node's global fetch resolved it again on connect, so a short-TTL DNS server could answer public to the guard and private to the connect.

Now the checked address is the connected address. Guarded requests go through undici's own `fetch` (undici 7.30.0, engines `>=20.18.1`, a direct dependency of `packages/api`) on one `Agent` whose `connect.lookup` is `vettedLookup` (`packages/api/src/lib/outbound-url.ts:212`, Agent at `:229`, fetch at `:274-276`). On every new socket it resolves the host through the same injectable resolver, refuses the connect when ANY answer is blocked (`resolveVetted`, `:198-201`, same `isBlockedAddress` ranges as the pre-check), and hands net/tls only the vetted addresses. The URL is not rewritten to an IP, so the Host header and TLS SNI stay the hostname. Node's global fetch is never given this Agent (its bundled undici is a different copy). A connect-time refusal is rethrown as `OutboundUrlBlockedError`, so callers see the same error as a pre-check refusal. The pre-check stays: it is the only check for literal-IP URLs (net skips `lookup` for an IP) and for the scheme, credentials and internal-name rules, and it runs on every redirect hop in `fetchOutboundFollow`.

Test seams, none of which the production path sets: `setOutboundFetch` (`:290`) replaces the network for unit tests; under the test-only private override the helpers use global fetch, so suites that stub it are unchanged (`selectFetch`, `:303`); `setBlockedAddressPolicy` (`:105`) lets a test admit 127.0.0.1 as a stand-in for a public host.

**Tests (real sockets, no mocked fetch).** `packages/api/tests/outbound-url-rebinding.test.ts`, 7 tests. The resolver answers public to the pre-check and 127.0.0.1 to the connect: refused, and a loopback server listening on the target port accepts 0 connections (RB-01); a mixed connect-time answer (RB-02) and a connect-time resolver failure (RB-03) are refused with 0 connections; a literal private IP is refused before DNS (RB-04); a name with no real DNS reaches a loopback server only through the connect-time answer, with `Host` still the name (RB-05); a 302 is returned, not followed (RB-06); in `fetchOutboundFollow`, a redirect hop that answers public to its pre-check and 127.0.0.2 to its connect is refused and a server listening on 127.0.0.2 accepts 0 connections (RB-07). `packages/api/tests/outbound-url-sinks.test.ts` now runs its real-loopback redirect and read-back tests on this undici path (override off, policy admits 127.0.0.1). Mutation check: with the connect-time `assertNoneBlocked` at `:201` removed, RB-01, RB-02, RB-07 and PO-06 failed (the loopback servers received the connection); with the Agent unwired from the fetch, 6 of 7 rebinding tests failed. Both restored, all pass.

### Same class, found after the guard landed

- **FIXED 2026-10-02: `store/schedules.ts` fetched `schedule.url`** (set through the `url` field of `POST /schedules`, `requireApiKey`). The body feeds the scan, so any key holder could read an internal URL back. The run now uses `fetchOutboundFollow` (`lib/outbound-url.ts`): the URL and every redirect hop (at most 3) go through the guard, and a redirect to a private address is refused, not followed. `POST /schedules` refuses a private `url` or `webhookUrl` with 400, and `PATCH /schedules/:id` refuses a private `webhookUrl`. Tests: `packages/api/tests/schedules-outbound-url.test.ts`, 8 tests. Mutation check: with the run-time guard removed 4 fail, with the route check removed 2 fail, restored 8 pass.
- **FIXED 2026-10-02 (was OPEN, admin only): `store/providers.ts:92`** POSTed to `plugin.endpoint`, set only through `POST /providers/register` (`routes/providers.ts:38`, `requireAdmin`). Registration now refuses a private endpoint with 400 `endpoint: Outbound URL blocked: ...` (`routes/providers.ts:51-52`), and `verify` sends through `fetchOutbound` (`store/providers.ts:95`): guarded on every call, connect-time lookup, `redirect: 'manual'`. Tests: `packages/api/tests/providers-outbound-url.test.ts`, 6 tests (registration 400 for the metadata IP and for a name resolving into `fdaa::/16`; verify refused when the endpoint turns private after registration, with no fetch; a real-socket rebinding verify gets 0 connections). Correction kept from earlier: `routes/plugins.ts` (`/plugins/publish`) only stores a marketplace listing and never fetches (`store/plugin-registry.ts` has no `fetch`). This was CodeQL #4.
- `lib/url-validator.ts:21` sends HEAD requests to source URIs that a model returned (`routes/deep.ts`). It returns the status code, so it is a blind probe that prompt injection can steer.

## 8. Security gate (ratchet)

Branch `security-gate`, PR https://github.com/nxtg-ai/faultline-pro/pull/59 (not merged). `.github/workflows/security-scan.yml` can now fail. Findings that existed on 2026-10-02 are baselined with a reason. Any new blocking finding fails the run, and so does a scanner that cannot run.

### What blocks

| Job | Fails when | Accepted list |
|---|---|---|
| Semgrep `--config auto` + `gate` | a result at level `error` (resolved from the rule's `defaultConfiguration`, since results carry no level) is not in the baseline | `security/baseline.json`: **0** semgrep entries |
| Bearer 2.1.1 (pinned) + `gate` | a level `error` result is not in the baseline | `security/baseline.json`: **99** bearer entries |
| Gitleaks 8.30.1 (pinned URL plus checksum), full history | any leak not in `.gitleaksignore` (`--exit-code 1`) | `.gitleaksignore`: 33 fingerprints, each group commented |
| Bandit 1.9.4 | any HIGH severity AND HIGH confidence result (`-lll -iii`) | none; 0 such results on 2026-10-02 (local run) |
| `npm-audit` | a high or critical GHSA in `npm audit --omit=dev --json --package-lock-only` is not accepted, or an accepted entry is past `review_by` | `security/accepted-advisories.json`: empty |

A crash fails the job, never passes it. Semgrep runs without `--error`, so it exits 0 on findings and non-zero on failure. Bearer's `exit-code: 0` covers only "findings reported"; a scan error still exits non-zero (`pkg/commands/artifact/run.go`, Bearer 2.1.1). `scripts/security-gate.mjs` exits **2** when a SARIF file is missing, empty, unparseable, from the wrong tool, lists no rules, or reports `executionSuccessful: false`, and when the npm report is an error report, not version 2, or audited zero production dependencies.

The fingerprint is tool + ruleId + file + Bearer's `primaryLocationLineHash`. Semgrep OSS gives none (its `matchBasedId` is the constant `requires login`), so semgrep falls back to sha256 of the whitespace-collapsed message. The line number is not part of it, so a finding that moves keeps its entry. The baseline is a multiset: a second copy of a baselined finding is new. Entries no longer found print as `STALE` and do not fail.

### The 5 semgrep errors from run 37062617182

- `release-protocol-check.yml:46` run-shell-injection: every expression inside `run:` in that workflow (16, the only workflow that had any) moved to step `env:` and is read as `"$VAR"`.
- `fly-deploy.yml:52` and `release-protocol-check.yml:109` gha-curl-pipe-shell: download to a file with `curl -fsS -o`, then parse the file.
- `Dockerfile` missing-user-entrypoint: by design (the entrypoint chowns the Fly volume as root, then drops to `faultline` with su-exec). `# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint` on the line above `ENTRYPOINT`, with the reason on the line above that. A trailing comment on the exec-form line would break its JSON. The gate treats a SARIF `suppressions` entry as not blocking.
- `.asif/NEXUS-archive-20260429.md` detect-insecure-websocket: prose. `.semgrepignore` excludes `.asif/`. A `.semgrepignore` replaces semgrep's built-in list, so the file restates it (node_modules, dist, build, vendor, test/tests, and more) and adds coverage, `.stryker-tmp`, reports and `.claude`.

### Bearer baseline triage (99 entries)

91 are `accepted-pre-existing` (81 javascript logger_leak, 4 manual_html_sanitization, 3 insufficiently_random_values, 1 dynamic_regex, 1 observable_timing, 1 go logger_leak). The other 8 were opened and carry their own reason:

| Rule | Location | Disposition |
|---|---|---|
| hardcoded_secret | `packages/api/benchmarks/run.ts:287` | false positive: the benchmark sets the placeholder `FAULTLINE_API_KEY='bench-key'` in its own process |
| hardcoded_secret | `packages/cli/lib/i18n.ts:39` | false positive: the message `err.no_api_key` |
| dangerous_insert_html | `packages/web/components/InputSection.tsx:186`, `Tour.tsx:81` | false positive: `React.createElement` of an icon from the static `FEATURES` constant |
| raw_html_using_user_input | `packages/api/src/routes/scans.ts:138`, `:177` | **FIXED 2026-10-02, kept as false-positive** (see "Fix: scan history scoped per API key" below). Was OPEN: `GET /scans/stale/view` needs only `requireApiKey` and calls `getScanUsageStats(staleDays)` with no tenant id. At `scans.ts:129` it writes `textPreview`, the first 100 characters of any caller's scan input (`routes/scan.ts:207`), unescaped into a `title` attribute and a cell. Any key holder can store script that runs for any other key holder who opens the page, and every key holder sees other tenants' input. Fix: `esc()` from `src/lib/html.ts` plus a tenant scope |
| raw_html_using_user_input | `packages/api/src/routes/keys.ts:126`, `:167` | **FIXED 2026-10-02, kept as false-positive** (see below). Was OPEN, low: `GET /keys/usage/view` writes `k.name` unescaped (`keys.ts:118`). Admin sets it (max 100 chars) and admin views it. Fix: `esc()` |

Fixing an OPEN item removes its finding only if the scanner stops reporting it; then the gate prints the entry as STALE and the entry is deleted in the same change. That did not happen for the two `raw_html_using_user_input` sites: Bearer 2.1.1 keeps reporting them after the fix, under the same fingerprint, so their entries stay with a `FIXED` reason (measured 2026-10-02, see the section below).

### How to accept or baseline

- **Bearer or Semgrep:** a failing gate prints a JSON stub per new finding. Fix the code, or paste the stub into `security/baseline.json` `entries` with a `disposition` (`accepted-pre-existing`, `false-positive`, `open`) and a one-line `reason`. An entry without a reason fails with exit 2. For a semgrep finding that is by design, prefer `# nosemgrep: <rule id>` beside the code with the reason.
- **Gitleaks:** add the `Fingerprint:` line from the job log (`commit:file:rule:line`) to `.gitleaksignore` under a comment saying why it is not a secret. A real secret is rotated, not ignored. Comments in `.gitleaksignore` must not quote the fake key: gitleaks scans that file too (it flagged its own comment on the first run).
- **npm audit:** the job prints a stub per unaccepted GHSA. Upgrade, or add `{ghsa, package, severity, disposition, reason, review_by}` to `security/accepted-advisories.json`. After `review_by` the entry fails the job until it is reviewed again.
- **Bandit:** no baseline. A HIGH/HIGH result is fixed, or suppressed in place with `# nosec <test id>` and a reason.

### Proof in CI

| Run | Head | Conclusion | Why |
|---|---|---|---|
| 37065802290 | `a0a7335` (temporary probe commit) | **failure**, `gate` job | `NEW BLOCKING: bearer javascript_lang_logger scripts/ratchet-probe.mjs:5`. The commit added a file that logs `user.email` |
| 37066020388 | `a2ac8ef` (revert of the probe) | **success**, all 6 jobs | `semgrep: 0 blocking findings`, `bearer: 99 blocking findings`, `PASS ... (99 baseline entries, 0 stale)`, gitleaks `no leaks found`, `npm audit: 0 high/critical advisories` |

Two earlier runs also went red on their own: 37064869158 failed because Bearer flagged two lines in the new `security-gate.mjs` and gitleaks flagged a fake key quoted in a `.gitleaksignore` comment. Both were fixed in the code and that commit was rewritten, so the gate was never baselined against its own findings. 37065316131 failed on one remaining Bearer line in the script.

The npm job is green because `ecb507f` (2026-10-02) cleared every high production advisory: the lockfile audit reports 0 high/critical with 308 production dependencies. With dev dependencies included, `npm audit --package-lock-only` reports 5 high (browserslist, nanoid, postcss, undici, vite). The gate does not count those (local run, 2026-10-02).

Tests: `packages/api/tests/security-gate.test.ts`, 29 tests. Mutation check, each change made alone and then restored: with the baseline comparison removed 7 fail; with levels read only from results 8 fail; with expiry ignored 1 fails; with unaccepted advisories ignored 3 fail; with invalid input passing 9 fail; restored 29 pass.

---

## Fix: scan history scoped per API key, and HTML escaping (Bearer XSS findings)

Branch `fix/scan-history-tenant-scope`, 2026-10-02.

### Defect

`store/scan-history.ts` keeps one in-memory list of every scan from every key. Each entry holds `keyId`, `tenantId`, `textHash` and `textPreview` (the first 100 characters of the submitted text, `routes/scan.ts:207`). Readers behind `requireApiKey` returned every key's entries. A caller-supplied `tenantId` could select another tenant's entries. `GET /scans/stale/view` also wrote `textPreview` into HTML unescaped, so any key holder could store script that ran for every other viewer of that page.

### Rule

A non-admin caller only reads, prunes or deletes entries whose `keyId` equals its own `request.keyId`. Admin callers keep fleet-wide reads. Admin here means the same callers `requireAdmin` accepts: the env `FAULTLINE_API_KEY` (keyId `admin`) or a keystore key with the `admin` permission (`plugins/auth.ts:110`). A `tenantId` query param is applied on top of the key scope, so it can only narrow.

- Store: one private `scoped(keyId?)` view (`store/scan-history.ts:59`), used by `getRecent` (`:70`), `search` (`:88`, applied before the cursor), `getTimeline` (`:115`), `getScanUsageStats` (`:140`), `getStaleScanGroups` (`:228`) and `pruneStaleGroups` (`:209`). When it prunes with a keyId, prune judges staleness on that key's entries and deletes only that key's entries (`:214`). Two keys can scan the same text, so pruning by hash alone would delete the other key's history.
- Routes: `scanHistoryKeyScope(request)` (`plugins/auth.ts:123`) returns `undefined` for admin and the caller's keyId otherwise. A request with no keyId gets a scope that matches nothing.

### Per route, before and after

| Route | Gate | Before | After |
|---|---|---|---|
| `GET /scans/usage` (`routes/scans.ts:81`) | requireApiKey | every key's previews and hashes. `?tenantId=` selected any tenant | caller's own entries. `tenantId` narrows within them |
| `GET /scans/stale/view` (`scans.ts:102`, HTML `:128-136`) | requireApiKey | every key's previews, unescaped in a `title` attribute and a cell | caller's own entries; every interpolated value goes through `esc()` (preview, hash, risk, providers, counts) |
| `GET /scans/stale` (`scans.ts:225`) | requireApiKey | every key's stale documents, `?tenantId=` any tenant | caller's own |
| `GET /scans/search` (`scans.ts:268`) | requireApiKey | full-text search over every key's previews | caller's own; `q`, `tenantId`, `cursor` stay inside the scope |
| `GET /scans/timeline` (`scans.ts:35`) | requireApiKey | `?text=` told any key whether anyone had scanned a given text, and returned their scans | caller's own scans. Two keys that scan the same text get separate timelines |
| `POST /export` (`routes/export.ts:151`) | requireApiKey | CSV/JSON/NDJSON of every key's history, including `keyId` and `tenantId` columns | caller's own |
| `GET /analytics/overview` (`routes/analytics.ts:450`) | requireApiKey | scan volume, provider mix, risk and latency trends over every key | the same aggregates over the caller's scans |
| `GET /keys/usage/view` (`routes/keys.ts:118-124`) | requireAdmin | `k.name` unescaped | `esc()` on name, id, dates, permissions |
| `DELETE /scans/stale`, `/dashboard`, `/mission-control*`, cache-warmup, `/risk-register`, `/tenants/:id` erase, `/tenants/:id/export` | requireAdmin | fleet-wide | unchanged, by design |

Response shapes are unchanged.

### Tests

`packages/api/tests/scan-history-tenant-scope.test.ts`, 27 tests. The setup uses two keystore keys A and B, the env admin key, and a tenant that holds key A. Entries are seeded with `getScanHistory().record(...)`.

- SHS1-SHS9 cover the store: every read method honours the key scope, a foreign `tenantId` cannot widen it, and prune with a keyId leaves the other key's entries for a shared hash.
- SHR1-SHR14 cover every `requireApiKey` reader above. B sees none of A's previews or hashes, A sees its own and admin sees both. `?tenantId=<A's tenant>` as B returns nothing. A keystore key with `admin` keeps fleet-wide reads. `DELETE /scans/stale` stays 403 for a scan key.
- SHX1-SHX4 cover escaping. `<script>alert(1)</script>` in a preview, and `<img onerror>` in a provider, render as `&lt;…&gt;` on `/scans/stale/view` with no raw tag, the title attribute cannot be broken out of, and a `<script>` key name is escaped on `/keys/usage/view`.

`security-gate.test.ts` SG-42 used to pin 4 `OPEN:` baseline reasons. It now pins 0 `open` entries and the 4 XSS entries as `false-positive` with a `FIXED` reason.

API suite: 2,703 tests in 148 files before, 2,730 in 149 files after, all passing. Root `npx tsc --noEmit` is clean. No existing fixture had to change, because every existing reader test uses the env admin key.

### Mutation check

Each mutant was applied alone, then `tests/scan-history-tenant-scope.test.ts` was run and the source restored. All 14 mutants were killed:

| Mutant | Red |
|---|---|
| store `search()` reads `this.entries` instead of the key scope | SHS7 SHR7 SHR8 SHR10 SHR14 (5) |
| store `scoped()` ignores keyId | 17 tests |
| store `pruneStaleGroups` deletes across keys | SHS8 |
| route `/scans/usage` drops the key scope | SHR1 SHR2 SHR14 |
| route `/scans/stale/view` drops the key scope | SHR3 SHR14 |
| route `/scans/stale` drops the key scope | SHR5 SHR6 SHR14 |
| route `/scans/timeline` drops the key scope | SHR9 |
| route `/export` drops the key scope | SHR10 |
| route `/analytics/overview` drops the key scope | SHR11 SHR14 |
| `scanHistoryKeyScope` treats every caller as admin | 11 tests |
| `isAdminKeyId` ignores the keystore `admin` permission | SHR12 |
| `/scans/stale/view` un-escapes `textPreview` | SHX1 SHX2 |
| `/scans/stale/view` un-escapes providers | SHX3 |
| `/keys/usage/view` un-escapes `k.name` | SHX4 |

### Bearer baseline: entries kept, re-dispositioned

The plan was to delete the 4 baseline entries once the sites were fixed, so the gate would print them as STALE. A local run of the pinned scanner (Bearer 2.1.1, the CI version, on `scans.ts` and `keys.ts` at their repo paths) showed that plan would turn the gate red:

- Bearer still reports `javascript_lang_raw_html_using_user_input` at the same 4 sites after the fix. It taints any request-derived value that reaches the HTML (`staleDays`, `dormantDays`, the key scope passed into the store) and does not treat `esc()` as a sanitizer. A probe file showed `esc()`, `escapeHtml()`, `escape-html`, `parseInt`, `Number()` and `Math.min` all still flagged.
- The fingerprint is path + rule + index and does not depend on content. Before the fix it was `58d7fa56…_0/_1` (keys.ts) and `b83631f7…_0/_1` (scans.ts), and after the fix it is the same. These equal the baseline entries.
- `node scripts/security-gate.mjs --sarif bearer=<post-fix sarif>` gives `PASS` with the entries kept. With the 4 entries deleted it gives `FAIL: 4 new blocking finding(s)` and exit 1.

So the 4 entries stay in `security/baseline.json`, with `disposition: false-positive` and a reason that starts `FIXED 2026-10-02`. The tests above (SHX1-SHX4) are the proof that the sites are escaped. Bearer does not prove it.

### Left open

- `/analytics/overview` still returns `cacheStats` and `claimCategories` from the process-wide scan cache and claim index. Those aggregates are counts with no text, but they are not per key.
- The `/scans/timeline/view` client script writes `e.provider` and `e.overallRisk` via `innerHTML`. These values are set by the engine, not by the caller, and the page is static server-side. Not changed here.
- Tenants: the scope is per key, not per tenant. Two keys in the same tenant do not see each other's history. That follows the rule above. If the product wants tenant-wide history for non-admin keys, that is a separate decision.
