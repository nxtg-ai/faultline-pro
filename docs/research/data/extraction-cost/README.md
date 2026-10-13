# Extraction cost by document size (2026-10-13)

For emma-soul al:2d7d2047383addb3 item 1 (CRO pricing pass: extraction runs before any charge).

- Script: `packages/cli/scripts-extraction-cost.ts` (engine extraction on the gemini provider, the production default, then the per-sentence guarantee; tokens from the provider's own usage report, priced at Gemini 2.5 Flash list $0.30 / $2.50 per million input / output tokens).
- Results: `results-bab5110.jsonl` (engine at bab5110).
- Documents are **not** committed: they are Wikipedia article text (CC BY-SA 4.0) and this repo is public. To rebuild them, fetch the plain-text extract of each article (`action=query&prop=extracts&explaintext=1`, fetched 2026-10-13 17:22Z), collapse blank-line runs, and cut at the last ". " before the target length:

| Bucket | Target | Documents |
|---|---|---|
| `short` (~1 page) | 3,000 chars | first 3,000 chars of Photosynthesis, Apollo 11, Great Barrier Reef, World War II, History of the United States, Brown v. Board of Education |
| `p10` (~10 pages) | 30,000 chars | first 30,000 chars of Photosynthesis, Apollo 11, Great Barrier Reef, Brown v. Board of Education |
| `p50` (~50 pages) | 150,000 chars | History of the United States + World War II, concatenated; Apollo 11 + Photosynthesis + Great Barrier Reef, concatenated |

A page is taken as about 3,000 characters. The `p50` documents are encyclopedia text, not a legal brief, so claim density may differ from a brief. The API caps input at 50,000 characters, so `p50` documents cannot be scanned through the product today; they were run against the engine directly to price them.

## Results (gemini-2.5-flash, 2026-10-13, engine bab5110)

Successful extractions only, list price. `results-bab5110.jsonl` ran 3 documents at a time; `results-bab5110-sequential-retry.jsonl` re-ran the 5 failures one at a time.

| Bucket | n | Cost p50 | Cost p90 | Wall time | Fact claims | Units (ceil/8) |
|---|---|---|---|---|---|---|
| short (~3k chars) | 6 | $0.0068 | $0.0090 | 23-45 s | 38-76 | 5-10 |
| p10 (~30k chars) | 4 | $0.0620 | $0.0686 | 137-220 s | 369-578 | 47-73 |
| p50 (~150k chars) | 0 of 2 | n/a | n/a | n/a | n/a | n/a |

Failures (7 attempts):
- **p50, 4 of 4 attempts:** in 3, the model's JSON stopped after about 8,000 characters (`SyntaxError: Unterminated string in JSON`, 2.6k-3.8k output tokens, about 4.5 minutes, $0.016-0.019 spent each); in 1 (the first 3-at-a-time run) the call failed after 239 s with no tokens reported. A 50-page document cannot be extracted in one call today; it needs chunked extraction.
- **p10 Photosynthesis, 1 of 2 attempts:** failed after 20k output tokens ($0.052), succeeded on retry.
- **short, 2 attempts at 3-at-a-time:** failed in under a second with no tokens used; both succeeded when re-run alone. The error text was not captured in the first run.
- **The engine hides all of these.** `extractClaims` (packages/cli/services/geminiService.ts) catches every error and returns no claims; the per-sentence guarantee then fills in one synthetic claim per sentence, so the failed p50 runs still reported 945 and 1,049 "claims". A quick scan built on that is not flagged degraded, and a full-scan estimate would price the synthetic claims.
