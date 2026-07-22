# BL-Faultline-billing — PROBE-FIRST reconcile (audit-only)

**Directive:** DIRECTIVE-NXTG-20260719-02 (AMENDED — staging removed, audit-only), Wolf/NXTG-AI CoS.
**Spec:** `/home/axw/ASIF/initiatives/undeniable-portfolio/specs/BL-Faultline-billing.md`
**Author:** fp (Faultline team) · **Date:** 2026-07-19 · **Scope:** Action Items 1–2 (probe-first reconcile + audit-class gap-closes). NO staging, NO live writes, NO charges (constraint honored).
**Method:** read-only, key-safe probes (secret TYPE/prefix only, never values). Billing surface lives in **faultline-web** (fw's repo); Faultline-Pro has no billing code.

---

## Reconcile table — spec claim → verdict + instrument

| # | Spec claim | Verdict | Instrument (re-runnable) |
|---|---|---|---|
| 1 | "Stripe WIRED, real SDK (not mock)" (§1/§3.5) | **CONFIRMED** | `faultline-web/lib/billing.ts:26` `new Stripe(STRIPE_SECRET_KEY, {apiVersion:'2026-02-25.clover'})`; checkout via `stripe.checkout.sessions.create` |
| 2 | "`lib/billing.ts` reads price IDs from env, at file/line" (§3A.2 — verify, don't inherit) | **CONFIRMED** | `billing.ts:78-84` `priceEnvMap = {personal: STRIPE_PERSONAL_PRICE_ID, pro: STRIPE_PRO_PRICE_ID, enterprise: STRIPE_ENTERPRISE_PRICE_ID}`; `priceId = priceEnvMap[plan]`. Env-driven, NOT hard-coded → §Effort-S "config flip" premise holds. |
| 3 | "Webhook verifies Stripe signatures" (§3A.2) | **CONFIRMED** | `app/api/billing/webhook/route.ts:24` `stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET)`; missing-sig→400, invalid→400, no-secret→500 |
| 4 | CLAIM A instrument: "a **live-mode `payment_intent.succeeded`** lands → entitlement flips" (§0 CLAIM A, §4 proof 1) | **REFUTED (named event wrong)** | `billing.ts::handleWebhookEvent` switches on **`checkout.session.completed`** (sets stripeCustomerId+subscriptionId) + **`customer.subscription.updated`** (`isActive = status==='active'\|\|'trialing'`). `payment_intent.succeeded` is **not handled** → it alone would NOT flip entitlement. **The acceptance instrument must be `checkout.session.completed` / subscription-active, not `payment_intent.succeeded`.** (BL-3 GC-5 class: the spec's own named instrument was stale.) |
| 5 | "`.env.local` names set, **values unverified**; revenue-DARK" (§1/§3.5/§7) | **PARTIALLY REFUTED** | `.env.local` has all 6 names (`STRIPE_{SECRET_KEY,PUBLISHER_KEY,WEBHOOK_SECRET,PERSONAL_PRICE_ID,PRO_PRICE_ID,ENTERPRISE_PRICE_ID}`) AND `STRIPE_SECRET_KEY` is a **`sk_live`** (live-mode) key — value-class verified (type only, key-safe). So the LOCAL secret is live, not empty. **Custody flag:** a live secret key resident in `.env.local` — spec §3A.1 wants live keys outside the working tree; note for rotation/hygiene. |
| 6 | "Vercel **prod** env is authoritative; probe it for STRIPE_* set/unset + live-vs-test" (§3A.1) | **RESIDUAL** | Vercel CLI not available/authed in this pane → prod env not probeable here. NEXT: `vercel env ls` on the fw project (fw-lane, key-safe) — the prod env, not `.env.local`, gates the first real click. |
| 7 | "Revenue-DARK — no live conversion has occurred" (§7) | **RESIDUAL (probe available)** | Not confirmable without Stripe read access. The resident `sk_live` key COULD answer it: a read-only `stripe payment_intents list --limit 5` (live mode) surfaces any existing live conversion — but that needs key-safe custody of the value + is a Stripe-account read (beyond this audit-read boundary). RECOMMEND that probe (read-only) before the founder card, to confirm DARK isn't stale (§6 refute-anticipation: "probe beats tracker both directions"). |
| 8 | §4 proof 6: test-count baseline (never-decrease) | **CONFIRMED baseline** | `faultline-web/tests/api/billing.test.ts` = **11** billing tests. faultline-web HEAD `cc330e5` on `main`, clean. |

---

## Audit-class gap-closes (Action Item 2 — §8 items needing no revenue action)

- **GC-1 (founder/seed exclusion list — the market-gate instrument):** the mechanism (a committed exclusion list of founder/family/seed Clerk emails+domains + Stripe customer ids, probed by a NON-author seat on conversion) is a governance artifact, buildable WITHOUT revenue action. **Discharge status: DRAFT-BLOCKED** — the list's CONTENTS (who counts as seed/family/portfolio-agent) require Asif input; cannot be populated by fp alone. → Escalation item for Wolf's card: request the seed/family/agent identity set, then commit the list before the funnel opens.
- **GC-3 (evidence-pack 5-component existence probes):** each of CLAIM B's 5 pack components (claim-forensics + SHA-256 chain manifest, EU-AI-Act risk-tier mapping, SARIF/CI artifacts, questionnaire-answer frame) needs a file/line existence probe or explicit to-BUILD status. **Discharge status: NOT-YET-PROBED** — deferred (the 0.9.0 engine capability probe is its own audit slice; several are known-live from BLG-005/N-series work — SARIF at `packages/cli/results.sarif`, EU-Act mapping shipped N-157/N-211, chain manifest per compliance-report — but a per-component file/line table is owed). → NEXT audit slice.

---

## Headline findings for Wolf's founder card

1. **Wiring is real and env-driven** — the "config-flip, effort-S" premise for activation HOLDS (claims 1–3 CONFIRMED at file/line).
2. **The spec's own CLAIM-A acceptance instrument is WRONG** (claim 4): entitlement flips on `checkout.session.completed`/`subscription active`, NOT `payment_intent.succeeded`. The founder card + acceptance proof must name the correct event, or a live `payment_intent.succeeded` would pass the letter while entitlement never flips.
3. **A live `sk_live` secret sits in `.env.local`** (claim 5) — hygiene/rotation flag; and it makes the DARK-is-stale question (claim 7) answerable via a read-only live PaymentIntents probe before any activation.
4. **Prod env (Vercel) is the real gate and is UNPROBED here** (claim 6) — the authoritative set/unset + live-vs-test state needs `vercel env ls` on the fw project.

**Constraints honored:** audit + gap-close only; no live-mode price create/modify, no charges, no prod writes, no GTM. Pricing ($39/user/mo REC) + revenue-activation GO remain **Asif-only** (via Wolf's card). Staging (test-clock e2e) — removed from scope per the amendment.

---

## GC-3 slice (Wolf next-slice, 2026-07-19 — 5-component probe + read-only live Stripe)

### CLAIM B evidence-pack: 5-component existence probe (file/line or to-BUILD)

| Component | Verdict | Instrument |
|---|---|---|
| 1. Claim-forensics results (claims + verdicts + risk) | **CONFIRMED (live 0.9.0)** | `packages/cli/types.ts` (Claim/VerificationResult), `packages/cli/cli/scan.ts` (ScanResult.claims + verifications + overallRisk) |
| 2. SHA-256 **chain** manifest | **to-BUILD** | Only `packages/cli/history/store.ts:29` `createHash('sha256')...substring(0,8)` — a **truncated 8-char hash used as an ID/nonce**, NOT a hash-linked chain (no prevHash/previous-linking anywhere). CLAIM B instrument (i) "chain manifest re-verifies via `sha256sum` chain check" is **NOT satisfied** by a real chain. |
| 3. EU-AI-Act risk-tier mapping | **CONFIRMED (live, N-157/N-211)** | `packages/cli/compliance/eu_ai_act.ts`, `report_generator.ts` (euRiskSummary: unacceptable/high/limited/minimal) |
| 4. SARIF / CI artifacts | **CONFIRMED (live)** | real SARIF generators: `packages/cli/cli/report.ts:718`, `packages/cli/cli/compliance-report.ts:1565`, `aggregate.ts:462` (tool.driver/runs) |
| 5. Questionnaire-answer frame | **to-BUILD (copy only)** | `packages/cli/cli/nudge.ts:2` is the questionnaire POSITIONING copy (NUDGE_COPY), NOT a generated Q&A pack component. The deliverable frame is not built. |

**GC-3 verdict:** CLAIM B's "assembly, not invention" is ~60% true — **3/5 components live, 2/5 to-BUILD** (chain-manifest + questionnaire deliverable). The pack can ship 3 real components today; the chain-manifest re-verification instrument and the questionnaire artifact are net-new builds (effort reflected → the spec's blanket "already exists" line is corrected here, per GC-3 acceptance).

### Read-only live Stripe verification (Wolf-authorized, key-safe)

- **Price-object mode/active + payment_intents (DARK-is-stale):** **RESIDUAL — the accessible key is EXPIRED.** Probed with the resident fw `.env.local` `STRIPE_SECRET_KEY` (key-safe, value never printed): key is **real** (107 chars, `sk_live` prefix, no placeholder word) but `GET /v1/balance` → `type=api_error, code=api_key_expired` ("Expired API Key"; Stripe auto-redacts value). All price + payment_intents calls returned the same. **Consequence:** cannot confirm/refute price mode/active or existing live conversions from this pane. The authoritative probe needs the **current Vercel-prod live key** (fw-lane; Wolf confirmed all 5 envs set in prod, al:09018b59) → `stripe payment_intents list --limit 5` (live) closes DARK-is-stale.
- **Hygiene finding:** an **expired live secret** sits in fw `.env.local` — confirms a rotation happened (good) but the stale key should be scrubbed from the tree.

**GC-3 constraints honored:** read-only only (GET /v1/prices, /v1/balance, /v1/payment_intents — no writes/charges), key-safe (value never in transcript; Stripe redacts on error). Live price + DARK verdicts pass to Wolf's card as RESIDUAL-with-named-instrument (current prod key).
