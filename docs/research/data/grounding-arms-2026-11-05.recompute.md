# Recompute seat, two-arm grounding run 2026-11-05

Fresh codex exec, read-only, on commit 7f1b6d1. Brief: the per-claim rows, the spend ledgers, the bar text verbatim and the seeds; no summary numbers given. Verdict file follows unedited.

**Overall FAIL: criterion 3 exceeds the cost limit.** Recomputed from per-claim rows using independent Python code; no summary file was read.

| Metric | A: Google | P: Parallel |
|---|---:|---:|
| Balanced accuracy | 0.7198948949 | 0.8015015015 |
| Unverified rate, all 200 | 19/200 = 9.5% | 4/200 = 2.0% |
| Mean cost/claim, rows | $0.0386202190 | $0.0102456225 |
| Mean cost/claim, spend ledger | $0.0386202190 | $0.0102456225 |
| Google grounded calls, rows and ledgers | 204 | 0 |

BA uses 193 binary-gold claims: 148 true and 45 false. Seven `not_enough_evidence` claims are excluded. `supported` predicts true; `contradicted` predicts false; abstentions and failures count as wrong.

**P − A = +0.0816066066**, paired bootstrap 95% CI **[+0.0183617468, +0.1481986126]**, using 2,000 resamples, seed 20260929, sorted shared binary IDs.

| Criterion | Result | Evidence |
|---|---|---|
| 1. BA and CI thresholds | PASS | Difference +0.08161 ≥ −0.05; lower bound +0.01836 ≥ −0.10 |
| 2. Unverified-rate threshold | PASS | P − A = −7.5 percentage points |
| 3. P cost strictly under $0.01/claim | **FAIL** | $0.0102456225, exceeding the limit by $0.0002456225 |
| 4. P ledger records zero Google calls | PASS | 0 calls |

Both arms contain the same 200 unique IDs with matching gold labels. No duplicate claim IDs, duplicate ledger `(id, attempt)` entries, missing/extra ledger IDs, or cost/call/attempt reconciliation problems were found. A has 204 spend entries; P has 200. A’s largest per-claim decimal cost discrepancy is $10⁻¹⁷, consistent with floating-point rounding; P reconciles exactly.

Point estimates match the project scorer exactly. The independent CI matches within floating-point precision. A Python-standard-library RNG cross-check produced [0.0206154, 0.1539967]; no criterion verdict changed with RNG choice.

VERDICT: FAIL criteria=P,P,F,P