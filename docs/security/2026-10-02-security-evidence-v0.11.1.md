# Security evidence: engine and API at v0.11.1 (2026-10-02)

GoPMO 1.18.7.3.6. Evidence only: no dependency or source change was made in this task.

| Field | Value |
|---|---|
| Collected | 2026-10-02, ~19:55–20:06 UTC |
| Tree scanned | `0aaeb2f` (main). `git diff --stat 04ba8fe HEAD` shows only `.asif/NEXUS.md` (1 line) changed since the v0.11.1 release commit `04ba8fe`, so the code is v0.11.1 |
| npm | 11.6.0 (`npm --version`) |
| Install state | No `node_modules` in the scanning worktree. `npm audit` and `npm ls --package-lock-only` read `package-lock.json` only |
| What ships where | Fly API image: root `Dockerfile:45` runs `npm ci --omit=dev` from the root lockfile, so the `--omit=dev` audit set is what runs on `faultline-api`. npm CLI (`@nxtg/faultline`): the repo lockfile does not ship; `npm i @nxtg/faultline` resolves its semver ranges fresh, so a lockfile finding on a CLI dependency means "pinned in our lockfile", not "on every user's machine" |

Every number below sits next to the command that produced it.

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
| 4 | js/request-forgery (critical) | `packages/api/src/store/providers.ts:92` | Reachable only through `POST /providers/register`, which is `requireAdmin` (`routes/providers.ts:39`) |
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

1. **RED: SSRF reachable by any API key holder.** `POST /webhooks/test` (`routes/webhooks.ts:82`) needs only `requireApiKey`, accepts any URL that parses, and returns status code and latency. That makes it a probe of Fly's internal network. This is CodeQL alert #5 (critical). Action: require admin, or resolve the host and refuse private, loopback, link-local and Fly `.internal` addresses before the fetch. Re-check `/webhooks/test/:id` and registered-webhook delivery the same way. Not live-probed in this task.
2. **RED: fastify 5.8.5 on the live API.** It carries an auth-bypass advisory (GHSA-p68q-wchp-6fh7) plus 3 more high validation and header-bypass advisories. Fix is in range (5.12.5). Action: merge Dependabot PR #57 after CI passes.
3. **RED: adm-zip 0.5.17 parses customer ZIPs.** Upload path is `routes/bulk.ts:25`, `:90`, behind `requireApiKey`. It carries 5 high decompression and memory advisories. Action: PR #54 (0.6.1, semver-major) plus a test on the bulk route.
4. **RED: the `fast-uri` override pins a vulnerable version.** Root `package.json:58` sets `"fast-uri": "3.1.2"`, which has 7 high advisories (SSRF and host confusion). `npm audit fix` and Dependabot cannot move it while the override stands. Action: raise the override to >=3.1.8 or remove it.
5. **RED: security-scan.yml is green regardless of findings.** Every scanner is `|| true`, `--exit-zero`, `continue-on-error` or `--exit-code 0`. Run 37054437598 is "success" with Semgrep 74, Gitleaks 33, Bearer 96 and Bandit 301 findings. Action: fail on high-severity Semgrep and on new Gitleaks hits, and add `workflow_dispatch`.
6. **AMBER: 101 open Dependabot alerts and 11 open Dependabot PRs**, the oldest from 2026-09-03; 74 alerts are runtime-scope. Production npm audit: 10 high and 6 moderate packages. Other runtime highs: js-yaml (PR #53), protobufjs and ws via `@google/genai`, `@fastify/static` via swagger-ui (semver-major), and brace-expansion.
7. **AMBER: 2 CodeQL critical and 13 high alerts open.** Beyond #5: #4 is admin-only SSRF, #6/#7 are regex injection and ReDoS on user rule patterns (`store/rules.ts`), #8 is resource exhaustion in `pdf-report.ts`, and #9 is clear-text logging in `cli/index.ts:1446`.
8. **AMBER: 43 stale code-scanning alerts** from Semgrep, Gitleaks and Faultline uploads (2026-04). They never auto-close because the workflow no longer uploads. Action: dismiss them, or re-enable SARIF upload so they track reality.
9. **GREEN: GHSA-mxc3-4648-6p7x.** No CVE assigned yet (`cve_id` null). faultline-pro does not use the action, and `@v1` resolves to the patched v1.1.1 (`f41f650`).
10. **GREEN: secrets.** 0 live secrets in the tracked tree. The 18 tree hits are placeholders and detection-test fixtures. Optional: add a `.gitleaksignore` for the fixtures so the history count means something.

Not done here, by scope: no dependency upgrades, no source edits, and no live probes against `faultline-api.fly.dev`.
