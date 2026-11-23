# Amendment A2 to `PREREG-g0.md`: runtime configuration of arms M and X against production (2026-11-23)

Filed before any run of arms M or X. Arm M measures the production engine's code, run locally. Its result is reported as "production engine code, run locally, configuration matched", never as hosted accuracy. This amendment names how the local runtime matches production and every way it differs.

## Production, as read on 2026-11-23

- **Models:** `GET /health` (admin) at about 01:45Z: version 0.12.3, commit 88c4350, `models.judge` `gemini-3.1-pro-preview`, `models.extraction` `gemini-3.5-flash-lite`, `models.fallback` `gemini-4-argon`.
- **Settings it sets:** the names come from the Fly `secrets-list` run of the fly-ops workflow (run 45095766089) and `packages/api/fly.toml`. Values are not readable, so each value below comes from `/health` or from production's own verdict provenance.
- **Engine-relevant settings:** `FAULTLINE_GEMINI_MODEL`, `FAULTLINE_GEMINI_EXTRACTION_MODEL`, `FAULTLINE_GEMINI_FALLBACK_MODEL`, `FAULTLINE_GROUNDING`, `GEMINI_API_KEY`, `PARALLEL_API_KEY`, `FAULTLINE_PASSAGE_LEG=on` (fly.toml), `NODE_ENV=production`.
- **Not set:** `FAULTLINE_PARALLEL_MODE`, `FAULTLINE_GEMINI_EXTRACTION_FALLBACK_MODEL`, `FAULTLINE_EXTRACTION_RETRY_MS`.
- **Gates, not engine behaviour:** `FAULTLINE_PROVIDER_SPEND_CAP(_USD)`, `FAULTLINE_CLAIM_METER`, `FAULTLINE_CUSTOMER_KEYS`, `FAULTLINE_MEASUREMENT_KEY`.
- **Retrieval:** production verdicts record `retriever: parallel-search`, `retrieverModel: parallel-search-advanced` (scans of 2026-11-23 00:40Z), so grounding is `parallel` in mode `advanced`, the code default when the mode is unset.

## Matched (M and X)

| Setting | Production | M and X |
|---|---|---|
| Judge model | `gemini-3.1-pro-preview` | `FAULTLINE_GEMINI_MODEL=gemini-3.1-pro-preview` |
| Extraction model | `gemini-3.5-flash-lite` | same (not used on this route) |
| Rate-limit fallback model | `gemini-4-argon` | `FAULTLINE_GEMINI_FALLBACK_MODEL=gemini-4-argon` |
| Grounding | `parallel` | `FAULTLINE_GROUNDING=parallel` |
| Parallel mode | `advanced` (default) | `FAULTLINE_PARALLEL_MODE=advanced` (same value, set explicitly) |
| Timeouts, output ceilings, retries, concurrency | code constants (`geminiCeilingConfig`, route concurrency 4); no override set | the same code constants; no override set |
| Extraction fallback, extraction retry delay | unset (code defaults) | unset |

**Change from `PREREG-g0.md`:** M and X now run with the production fallback model set, not without one, so the judge path matches production. The `--judge-model` stop is therefore not used. Every row records the model that judged it; the share answered by `gemini-4-argon` is reported for each arm. The harm check is read on all rows, and again on rows judged by `gemini-3.1-pro-preview` alone as a secondary reading.

## Differences, all of them

1. **Google project and key:** Faultline Measurement (`gen-lang-client-0212165467`, own rate limits, 50 USD cap) instead of production's project.
2. **Parallel key:** the local key may not be the same key as production's. Same service and mode.
3. **Search cache:** M writes each search to a local cache and X reads it. Production has no cache. Writing does not change M's verdicts.
4. **`NODE_ENV`:** unset locally, because the search cache refuses to run under `production`. Production sets `production`.
5. **Node:** v20.20.2 locally; production's image is `node:20-alpine` (same major version, minor not read).
6. **Host:** NXTG-AI (WSL), not a Fly machine in `lax`; network latency differs.
7. **Request pacing:** the runner sends batches of 5 with 30-second pauses. Production serves customer requests unpaced.
8. **Spend gate:** a local provider-spend cap of 15 USD, on; production's is 300 USD. It is a gate, not engine behaviour, and the 4 USD per-arm guard stops a run first.
9. **Passage leg** (`FAULTLINE_PASSAGE_LEG`): on in production, unset locally. `POST /admin/verify-claims` does no evidence fetch on either.
10. **Other provider keys** (OpenAI, Anthropic): set in production, unset locally. Not used on the Gemini judge path.
11. **Code:** M is 6b2f410 (production's 88c4350 plus docs-only commits). X is the head of the judge-rule PR, recorded in every row.
