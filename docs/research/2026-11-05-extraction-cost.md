# Extraction cost per scan, measured on G0 inputs, 2026-11-05

Measures the extraction leg on its own: the single Gemini call that splits submitted text into claims, before any retrieval or verdict. The per-claim verify cost on the Parallel path (0.01024 USD, `2026-11-05-judge-not-checkable-g0.md`) does not include it.

- **Engine:** main at 2c9e5cb. `extractForFullScan(text, 'gemini')`, the same `extractClaims` call `/scan` makes. Extraction runs no search and is the same in both grounding modes.
- **Pricing:** each captured usage leg priced by `summarizeScanUsage` (`packages/api/src/store/consensus-cost.ts`), the function the provider-spend ledger uses: gemini-2.5-flash at 0.30 USD per million input tokens and 2.50 USD per million output tokens, at list price, not an invoice. Every call returned usage, and no call was unrated.
- **Inputs:** the Factcheck-Bench G0 claims (`factcheck-bench-subtask4-claim-factuality.jsonl`).
  - `single`: the 200 claims of the per-claim run, one claim per call.
  - `doc10`: 66 documents, each 10 consecutive claims from the gold file joined into one text (claims 0 to 659). Consecutive claims come from the same benchmark response, so a document reads like a short AI answer.
- **Script:** `scripts/measure-extraction-cost.mts`. **Rows:** `data/extraction-cost-2026-11-05.jsonl`, one per call: set, ref, characters, claims in and out, tokens, cost. They hold no model output.

| Set | Calls | Errors | Mean cost | Median | p90 | Mean input tokens | Mean output tokens | Mean claims out | Mean characters |
|---|---|---|---|---|---|---|---|---|---|
| single | 200 | 0 | 0.00139 USD | 0.00098 USD | 0.00321 USD | 191 | 533 | 1.3 | 76 |
| doc10 | 66 | 0 | 0.00446 USD | 0.00439 USD | 0.00522 USD | 329 | 1743 | 10.4 | 758 |

Total spend for the run: 0.57 USD at list price.

What it means:
- **A 10-claim scan costs about 0.0045 USD to extract**, which is under half the cost of verifying one claim (0.01024 USD).
- **Output tokens are about 98% of the cost**, and they grow with the number of claims extracted. Input length matters little at these sizes.

Limits:
- The documents are benchmark claims joined together: dense, short and factual. A real scan with more prose around its claims has more input tokens, but at 0.30 USD per million they add little. More claims per scan add output tokens roughly in proportion.
- No production scan was measured, because scan text is not stored.
