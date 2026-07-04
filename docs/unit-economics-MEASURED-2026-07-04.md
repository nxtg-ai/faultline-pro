# v0.9.0 Consensus Unit-Economics — MEASURED Results (for Wolf checkpoint-2)

**Directive**: DIRECTIVE-NXTG-20260703-04 / PRM-NXTG-20260703-04 (pricing blocked on a MEASURED cost/scan).
**Author**: `fp` | **Run**: 2026-07-04 02:30–02:34 UTC | **Status**: MEASURED — awaiting Wolf checkpoint-2, then Asif card.
**Method**: real provider-reported token usage teed off the wire on 18 live scans (design: `docs/unit-economics-measurement-design-2026-07-03.md`). Raw per-call: `scripts/consensus-cost/measured-usage.jsonl` (272 records). Rates: `scripts/consensus-cost/rates.ts` (pinned 2026-07-03; opus $5/$25 verified vs canonical claude-api ref).

---

## Headline (lead the Asif card with this)
**The pricing anchor's UNIT changed and the magnitude jumped ~4 orders past the telemetry estimate.** Old app = Gemini-Flash **~$0.03/CALL**. v0.9.0 consensus = **$0.20–$0.71 per SCAN** (13–33 real LLM calls/scan). And the deployed cost telemetry reports **~$0.00002/scan** — an **11,000–16,000× undercount** — so no one saw it.

## MEASURED cost/scan (real provider usage × live rates)
| Doc size | K (claims) | Consensus $/scan | Single-model $/scan |
|---|---|---|---|
| SMALL (~3 claims) | 3 | **$0.20 – $0.26** | $0.0003 |
| MEDIUM (~6 claims) | 6 | **$0.41 – $0.53** | $0.0006 |
| LARGE (8, K-cap) | 8 | **$0.55 – $0.71** | $0.0009 |

- **Range per size = a web_search-per-call SENSITIVITY BAND**: low = $0.010/call (OpenAI current-page figure), high = $0.030/call (historical gpt-4o tool $25–35/1k). The retrieval leg is the dominant cost, so this band is the main uncertainty — reported honestly, not hidden.
- n=3 reps/cell; **within-cell variance <1%** (cost is stable per doc-size). True p50/p90/p99 over a *usage* distribution needs real traffic (FP is pre-revenue) — the size tiers bound it: any percentile sits in **$0.20 (small) … $0.71 (large-high)**. p50≈p90≈p99≈mean at n=3 (do not over-read the per-cell percentiles).

## Where the cost actually is (real tokens — Wolf: measured==provider-usage)
| Call-type | Model | Calls | Input tok | Output tok | Cost | Share |
|---|---|---|---|---|---|---|
| **web_search (retrieval)** | gpt-4o | 51 | **886,120** | 35,887 | **$3.08** | **~88% (low band) / ~91% (high band)** |
| grounded-verify | claude-opus-4-8 | 50 | 31,469 | 8,949 | $0.38 | 10% |
| grounded-verify + extraction | gpt-4o-mini | 120 | 34,652 | 11,741 | $0.012 | <1% |
| grounded-verify | gemini-2.5-flash | 51 | 19,789 | 3,131 | $0.014 | <1% |

**The cost is a RETRIEVAL problem, not a consensus-voting problem.** ~88% (low band) / ~91% (high band) is gpt-4o ingesting web-search content (~17k tokens/call). The multi-model voting Asif worried about (the Opus leg) is only ~10%. **Dropping consensus voters saves ~11%; optimizing retrieval (cheaper retrieval model, trim/cap search results, cache) is the real lever.**

## Fan-out / consensus multiplier
Consensus vs single-model: **~620–860× per scan** — but that gap is because consensus-mode ALSO turns on per-claim `web_search` grounding (the ~88% (low band) / ~91% (high band) leg); single-model here does no grounding. So the multiplier is a *grounding-retrieval* effect, not the N-provider vote fan-out. Vote fan-out alone ≈ +11%.

## Telemetry gap (fix-spec quantification — BLG-CLX9-20260703-005)
| Size | Measured | Deployed telemetry estimate | Undercount |
|---|---|---|---|
| SMALL | $0.2015 | $0.0000140 | **14,443×** |
| MEDIUM | $0.4113 | $0.0000252 | **16,321×** |
| LARGE | $0.5492 | $0.0000492 | **11,162×** |
Compounds the 3 defects: (1) tokens estimated from input-doc text-length (blind to the 886k retrieval tokens), (2) models 1 provider — ignores the 1+K(1+N) fan-out, (3) claude leg priced Haiku not Opus (6.25×). Fix = capture real usage + sum the fan-out + correct model rates (harness here is the reference impl).

## Margin table (Asif decision)
**$19/mo subscription — break-even scans/user/mo = 19 ÷ cost/scan:**
| Doc mix | Cost/scan | Break-even scans/mo |
|---|---|---|
| all small | $0.20 | **95** |
| typical (medium) | $0.41 | **46** |
| large (low) | $0.55 | **35** |
| large (high band) | $0.71 | **27** |
→ A $19/mo user exceeding ~27–95 scans/mo (by doc size) is **gross-margin-negative**. Heavy users bleed.

**$19 one-time — margin = 19 − (avg scans/license × cost/scan), bounded 5/20/50 (Emma's sensitivity, FP pre-revenue):**
| Scans/license | Margin @ $0.20 | Margin @ $0.71 |
|---|---|---|
| 5 | +$18.0 | +$15.4 |
| 20 | +$15.0 | +$4.8 |
| 50 | +$8.9 | **−$16.5** |
→ **VERDICT FLIPS NEGATIVE within the 5–50 band at the high end.** One-time pricing is **volume-fragile** (Emma's predicted finding — CONFIRMED). A single power-user on large docs can go underwater on a $19 one-time.

## Honest disclosures (for Wolf checkpoint-2)
1. **Gemini leg attributed deterministically post-hoc.** The Gemini API carries `model` in the URL path, not the request body, so the tee logged `model:'?'` for all 51 gemini-verify calls and the harness excluded them (WARN lines). Corrected here to `gemini-2.5-flash` (deterministic: no `FAULTLINE_GEMINI_MODEL` override in env → `geminiService.ts:8` default). Impact tiny (SMALL $0.2001→$0.2015). Harness patched so the reference impl attributes it correctly (no re-spend — attribution is deterministic).
2. **Rates keyed on each call's real emitted model** (harness line 189), except the gemini URL-model case above (corrected deterministically).
3. **web_search per-call is the load-bearing uncertainty** → carried as the $0.010–$0.030 band, not a point estimate.
4. n=3 reps → per-cell percentiles ≈ mean; the real distribution is across doc-size, bounded $0.20–$0.71.

## Spend for this measurement
18 scans, 272 real LLM calls. Dominated by gpt-4o web_search (886k input tokens). Est. actual spend ~$3–4 (the measured cost of the matrix itself). Logged in `measured-usage.jsonl`. Within the low-single-digit-$ estimate; flagging it landed at the top of that range because web_search token volume is high. **Asif rotates the 3 keys after this (Emma disclosure).**
