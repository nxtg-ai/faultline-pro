# Faultline UI Consolidation — Docs + Plan (PLAN ONLY)

**Directive**: DIRECTIVE-NXTG-20260703-03 (Wolf, routing Asif FP-row item 3 — "the four-UI-per-ICP is a complete mess").
**Author**: `fp` team | **Date**: 2026-07-03 | **Status**: PLAN — do NOT build (plan-mode per execution-strategy).
**Method**: probe-grounded (git ancestry, package identity, file presence, live-deploy topology). Not a NEXUS-read.

---

## (a) What each surface actually is — 6 faultline surfaces

| # | Repo (`~/projects/`) | pkg name | Commits | Last commit | Reality |
|---|---|---|---|---|---|
| 1 | `fpw1-enterprise` | — | 1 | 2026-04-20 | **DEAD STUB** — PTC Phase-0 template scaffold (`src/app` skeleton). Never developed. |
| 2 | `fpw2-platform` | — | 1 | 2026-04-20 | **DEAD STUB** — PTC template scaffold. Never developed. |
| 3 | `fpw3-practitioner` | — | 3 | 2026-04-20 | **DEAD STUB** — PTC template scaffold. Never developed. |
| 4 | `fpw4-builder` | `faultline-web` | 296 | 2026-06-13 | **STALE CLONE** of the canonical line (see ancestry below). NEXUS titled "FPW4 Builder, ICP-4 indie hackers"; multi-brand routing + builder/admin tooling + Show-HN launch state. |
| 5 | `faultline-web` (P-08c) | `faultline-web` | 315 | 2026-06-21 | **CANONICAL** — strict superset of fpw4-builder + 19 newer commits (consensus render, NLI faithfulness, verify-honesty, demo capture). Portfolio P-08c GREEN. |
| 6 | `faultline-action` | — | 1 | 2026-04-20 | **KEEP, SEPARATE** — a GitHub Action (CI-marketplace form factor), not a UI. Out of the consolidation. |

### The smoking gun (deterministic, git-probed)
- `fpw4-builder` and `faultline-web` share the **same package name** (`faultline-web`), the **same README tagline** ("The governance layer for AI agents"), the **same stack** (Next 16.2.9, React 19.2.3, Clerk, Tailwind v4, shadcn, Stripe, Vercel KV, `@google/genai`, `@xyflow`), and the **same body-kit files** (`lib/brands.ts`, `lib/themes.ts`, `lib/fp-proxy.ts`, `middleware.ts`, `app/api/scan/route.ts`, `public/embed.js`).
- **Git ancestry**: `comm -12` of the two commit-SHA sets = **296 shared** — i.e. **100% of fpw4-builder's 296 commits exist inside faultline-web's 315**. faultline-web ⊇ fpw4-builder. This is not "two divergent forks needing a merge" — it is **one linear line**: faultline-web = fpw4-builder + 19 commits.
- **Consequence**: there is **nothing unique to port from fpw4-builder** (it is a proper subset). fpw4-builder is a stale checkout, 19 commits behind, frozen 8 days before faultline-web's tip.
- Both `.asif/NEXUS.md` headers read "NEXUS — FPW4 Builder, ICP-4 indie hackers" — faultline-web's was **copied from the fpw4 clone**, which is the origin of the identity ambiguity Asif is seeing.

### What the "4 UIs per ICP" was supposed to be
The design intent (per fpw4-builder NEXUS) was a **"Multi-ICP Body-Kit Architecture"**: ONE codebase serving 4 ICP surfaces (enterprise / platform / practitioner / builder) via **brand + theme + subdomain routing** (`lib/brands.ts`, `lib/themes.ts`, subdomain `middleware.ts` → `enterprise.faultline.nxtg.ai`, `pro.faultline.nxtg.ai`, …). That architecture **already exists and works inside the canonical repo.** ICP is a **config dimension**, not a repo. The "mess" is that instead of one body-kit + config, the tree accumulated: 1 canonical repo + 1 stale clone (same name) + 3 abandoned per-ICP scaffolds.

---

## (b) Consolidation PLAN (proposal — Asif/fw-gated, do NOT build yet)

**Target end-state**: ONE canonical repo (`faultline-web`, P-08c) driving all ICP surfaces via the existing brand/theme/subdomain body-kit. Zero same-name duplicate. Dead stubs archived, not littering `~/projects`.

**Canonical = `faultline-web`** — decided by evidence, not preference: it is a **strict superset** of fpw4-builder (0 unique commits lost by retiring the clone), holds the **newest + differentiated** product value (consensus / NLI faithfulness / verify-honesty), and **is** the portfolio P-08c GREEN entry.

### Step 0 — GATING PROBE (must pass before any archive; not yet run — PLAN only)
- **Deploy topology**: determine which repo backs each LIVE Vercel project/subdomain. fpw4-builder has `vercel.json` + an `enterprise.faultline.nxtg.ai` rewrite and a NEXUS "SHOW HN RESUMED / Asif UAT pass" claim → **a live Vercel project may still be wired to the fpw4-builder repo**. If so, archiving is blocked until the Vercel project is re-pointed to faultline-web (or confirmed already pointed there). **This is the one real risk** — verify with `vercel project ls` / dashboard before touching fpw4-builder.
- Confirm faultline-web `sota-step1-verify-honesty` (8 ahead of main) is intended to merge to main, or fence it — so "canonical" = a single releasable branch.

### Step 1 — Reconcile canonical identity (in `faultline-web`, fw lane)
- Fix `.asif/NEXUS.md` header: "FPW4 Builder / ICP-4 indie hackers" → true Faultline Web multi-ICP identity (drop the copied ICP-4-only framing).
- Confirm `package.json` name/description reflect the canonical product, not the clone.

### Step 2 — Retire `fpw4-builder` (after Step 0 passes)
- No cherry-pick needed (subset). Tag `archive/fpw4-builder-final` at `977f1a3` for history, then **remove from active `~/projects`** (or `git mv` to an `~/projects/_archive/`) to kill the same-name collision. Do **not** hard-delete; archive. _(fpw4-builder subset claim still holds — it has a remote (faultline-web) and is a strict git subset. Unchanged by the addendum below.)_

### Step 3 — ~~Retire `fpw1/fpw2/fpw3` stubs~~ **SUPERSEDED by ADDENDUM (2026-07-03) — see below**
- > **SUPERSEDED.** This step called fpw1/2/3 "dead PTC scaffolds" and claimed zero-loss archival. Both were WRONG: (1) the zero-loss/subset math applied ONLY to fpw4-builder, never to fpw1/2/3 (separate disk-only repos, never in that ancestry); (2) functional probe shows they are hand-built ICP landing pages with real unique content, NOT scaffolds. Corrected sequencing + findings in the ADDENDUM.

### Step 4 — Keep `faultline-action` as its own product
- Different form factor (CI action). Out of scope; leave as-is.

### Step 5 — Portfolio bookkeeping
- PORTFOLIO.md: collapse the fpw1-4 references; P-08c `faultline-web` is the single Faultline UI. Update the machine/NEXUS pointers.

### Ownership / boundary note
`faultline-web` (P-08c) is the **fw** lane, not `fp` (FP-CORE = the engine/API/CLI). This plan is a **recommendation teed for Asif + fw** — `fp` does not own the faultline-web build or the archive execution. `fp`'s deliverable per the directive is this docs+plan; execution is fw/Asif-gated.

---

## ADDENDUM (2026-07-03, 20:47 UTC) — Step-0a/0b reconcile vs Asif ground truth

**Trigger**: Asif direct input (15:42 CDT, via Emma) — *"we have fully built out web POCs for each ICP"* — contradicts the original "3 dead stubs" premise. Emma's ssh probe (15:44) added: fpw1/2/3 are **disk-only, no remote, zero fpw repos in the org**. Wolf + Emma locked **durability-first** sequencing. This addendum reconciles the plan with probed ground truth. Neither Asif's claim nor my prior probe is an oracle — both were validated; both were partly wrong.

### Correction I own
My original Steps 2–3 said "archive 3 dead stubs, zero-loss (superset)." The zero-loss/subset proof (296⊂315) applied **only to fpw4-builder vs faultline-web** — I wrongly extended it to fpw1/2/3, which were **never in that ancestry** (separate disk-only repos). Archiving them on subset-math would have been **unrecoverable loss of real work**. Flaw acknowledged.

### Step-0a — DURABILITY PUSH ✅ DONE + VERIFIED (2026-07-03 20:47 UTC)
Pushed all three disk-only repos to the org AS-IS (pure durability, no judgment, no dir touched):
| Repo | Remote | HEAD (local==remote) | Commits |
|---|---|---|---|
| `nxtg-ai/fpw1-enterprise` | created (private) | `1c7ea78` ✅ MATCH | 1 |
| `nxtg-ai/fpw2-platform` | created (private) | `712f6ad` ✅ MATCH | 1 |
| `nxtg-ai/fpw3-practitioner` | created (private) | `546e21c` ✅ MATCH | 3 |
Verified via `git ls-remote` (remote HEAD == local HEAD, all commits present). **Unrecoverable-loss risk eliminated — nothing archives-destroys now.** (Wolf independently re-verifies via `git ls-remote` per his seat.)

### Step-0b — FUNCTIONAL BUILD-OUT PROBE (incl. git history) — findings
"Build-out hidden behind the PTC strip" hypothesis: **CHECKED, does not hold.** fpw1/fpw2 = 1 commit each (no history behind); fpw3's build-out (the "practitioner landing MVP," +6011 LOC) is **present in HEAD** — the strip only removed node_modules. Nothing valuable is buried. None are create-next-app scaffolds (my "dead template stub" call was wrong on that axis too).

| Repo | Verdict | Routes | Scans engine? | ICP content |
|---|---|---|---|---|
| `fpw1-enterprise` | **PARTIAL-POC** | 1 (landing) | Client exists but **orphaned dead code** (renders mock-data) | Real: EU-AI-Act countdown, compliance widgets, procurement/SSO copy |
| `fpw2-platform` | **MIS-SLOTTED** | 1 (landing) | No | **NOT Faultline — it's a "Dx3 \| Context Layer" landing** (0 faultline refs) |
| `fpw3-practitioner` | **PARTIAL-POC (only one that scans)** | 1 (landing) | **Yes, end-to-end** (action→`/scan`→results) + test suite | Real: practitioner/solo framing, live demo, confetti UX |

Reference: `faultline-web` (canonical) has 21+ routes (dashboard/scan/results/history/batch/pricing/admin). The three fpw repos are **single-route landing pages of uneven completeness.**

### Reconciliation (the honest middle)
Asif's *"fully built out POCs"* and my *"dead stubs"* are **both partly wrong**. Truth: **real, hand-built, ICP-specific landing pages of uneven completeness** — partial POCs / marketing surfaces, not full working ICP products, and one (fpw2) holds a **different product's page (Dx3)** entirely. Asif is right that real per-ICP web work exists; "fully built out working POCs" overstates it.

### Revised plan (replaces Steps 2–3 for fpw1/2/3)
1. **Step-0a DONE** — durability secured.
2. **Reconcile card to Asif** — surface the middle-truth table above; his claim + the probe now *agree on the facts* (real work, uneven, one mis-slotted), disagree only on the word "full." Let him rule on intent: were these meant to be full POCs (→ resource to finish), or landing experiments (→ fold the good parts in)?
3. **Plan flips ARCHIVE → CONSOLIDATE-PRESERVING-ICP-VARIANTS**: evaluate each for fold-in to the canonical body-kit — fpw1's compliance widgets + EU-AI-Act countdown, fpw3's working scan-demo + tests are **real unique assets** worth porting, not discarding.
4. **fpw2 anomaly** — flag: the "platform ICP" slot contains a Dx3 landing. Either the real platform POC lives elsewhere (ask Asif) or the Dx3 page landed here by mistake. Do not treat fpw2 as the platform POC until resolved.
5. **fpw4-builder** — subset claim intact (has remote, strict git subset of faultline-web); still archivable after the Step-0 live-Vercel check. Unchanged.
6. **Nothing archives** until Asif's ruling + the probe agree AND the live-Vercel check passes.

## One-line summary for the room _(revised per addendum)_
6 "faultline UIs" = **1 canonical (`faultline-web`, P-08c)** + **1 stale same-name clone (`fpw4-builder`, strict git subset → archivable after live-Vercel check)** + **3 real-but-uneven ICP landing POCs (`fpw1/2/3`, now durability-pushed → CONSOLIDATE-PRESERVING, not archive; fpw2 is mis-slotted Dx3 content)** + **1 separate GitHub Action (keep)**. The clone is a merge-free archive; the three ICP landings hold **real unique work** (compliance widgets, working scan-demo+tests) → fold-in, not discard. Nothing archives until Asif's ruling + probe agree + live-Vercel check passes.
