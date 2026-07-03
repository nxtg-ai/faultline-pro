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
- No cherry-pick needed (subset). Tag `archive/fpw4-builder-final` at `977f1a3` for history, then **remove from active `~/projects`** (or `git mv` to an `~/projects/_archive/`) to kill the same-name collision. Do **not** hard-delete; archive.

### Step 3 — Retire `fpw1/fpw2/fpw3` stubs
- Dead PTC scaffolds; the 4-ICP intent is served by the body-kit inside faultline-web. Archive the same way (tag + move to `_archive`), remove from active tree. Update the PTC/PORTFOLIO catalog rows to "archived — folded into P-08c body-kit".

### Step 4 — Keep `faultline-action` as its own product
- Different form factor (CI action). Out of scope; leave as-is.

### Step 5 — Portfolio bookkeeping
- PORTFOLIO.md: collapse the fpw1-4 references; P-08c `faultline-web` is the single Faultline UI. Update the machine/NEXUS pointers.

### Ownership / boundary note
`faultline-web` (P-08c) is the **fw** lane, not `fp` (FP-CORE = the engine/API/CLI). This plan is a **recommendation teed for Asif + fw** — `fp` does not own the faultline-web build or the archive execution. `fp`'s deliverable per the directive is this docs+plan; execution is fw/Asif-gated.

---

## One-line summary for the room
6 "faultline UIs" = **1 canonical (`faultline-web`, P-08c)** + **1 stale same-name clone (`fpw4-builder`, a strict git subset — archive)** + **3 dead template stubs (archive)** + **1 separate GitHub Action (keep)**. Consolidation is mostly **archival, not a merge** — git ancestry proves the clone has zero unique work. Only real risk: verify no live Vercel deploy is still wired to `fpw4-builder` before archiving it.
