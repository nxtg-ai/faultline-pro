# FR-3 — Per-Stage Model Routing (PipelineConfig)

**Priority**: HIGH (highest ROI change in roadmap)  
**Filed**: 2026-04-17  
**Filed by**: faultline-web team (DIRECTIVE-NXTG-20260416-01)  
**Status**: SHIPPED (N-220, v0.5.3) — `d6a35b3` per-stage `PipelineConfig` routing; `0ecc198` first live FR-3 scan for FW integration. Impl: `packages/api/src/routes/scan.ts:89` (`pipelineConfig` path), `packages/api/src/routes/stream.ts`; tests `packages/api/tests/scan-pipeline-config.test.ts`. Stale-`PENDING` corrected 2026-07-08.

---

## Problem

A single provider handles the entire scan pipeline. Routing everything through one model is suboptimal at every stage: extraction doesn't need grounding, verification benefits from Google Search integration, synthesis and critique benefit from long-context reasoning and EU AI Act domain knowledge. The result is either overpaying for extraction+verification (Claude/GPT-4o) or undershooting on synthesis (Gemini Flash).

## Optimal Per-Stage Routing (April 2026 SOTA)

| Stage | Optimal Provider | Why | Est. cost |
|---|---|---|---|
| `extractClaims()` | GPT-5.4 Nano | 193 TPS, $0.20/$1.25, JSON-adherent, no grounding needed | ~$0.002/scan |
| `verifyClaim()` | Gemini 3 Flash | Native Google Search grounding, 218 TPS, GA | ~$0.008/claim |
| `complianceReport()` | Claude Sonnet 4.6 | Best EU AI Act domain knowledge, structured output | ~$0.04/scan |
| `analyzeWeakestLinks()` | N/A | Pure computation — no LLM call | $0 |
| `generateCritique()` | Claude Sonnet 4.6 | Deep reasoning, best improved-prompt quality | ~$0.06/scan |

**Estimated cost reduction vs all-Gemini baseline: 40–60%.**

## Request

Add optional `pipelineConfig` to `POST /scan` and `POST /scan/stream` (FR-1) request body:

```ts
type ProviderName = 'gemini' | 'openai' | 'anthropic' | 'groq';

interface PipelineConfig {
  extractionProvider?: ProviderName;    // default: current single provider
  verificationProvider?: ProviderName;  // default: current single provider
  synthesisProvider?: ProviderName;     // complianceReport + generateCritique
}
```

Request body:

```json
{
  "text": "...",
  "provider": "gemini",
  "pipelineConfig": {
    "extractionProvider": "openai",
    "verificationProvider": "gemini",
    "synthesisProvider": "anthropic"
  }
}
```

The engine instantiates up to 3 provider clients per scan (only those specified). `provider` field remains as the single-provider fallback when `pipelineConfig` is absent.

## Engine Architecture Notes

- `extractClaims()` → instantiate `pipelineConfig.extractionProvider ?? provider`
- `verifyClaim()` → instantiate `pipelineConfig.verificationProvider ?? provider` (one instance, reused across all claims)
- `complianceReport()` + `generateCritique()` → instantiate `pipelineConfig.synthesisProvider ?? provider`
- `analyzeWeakestLinks()` → no change, pure computation

Provider instantiation is already per-call in the current engine (not a singleton). Multi-provider requires 2–3 concurrent provider instances, which should be within current memory budget.

## faultline-web Impact

faultline-web would expose `pipelineConfig` in two places:

1. **Advanced scan options** (Pro/Enterprise tier) — UI toggle in the paste box for power users
2. **`/api/scan` route** — forward `pipelineConfig` from request body to FP, same as `provider` today

No changes needed to SSE parsing or result display — `PipelineConfig` is purely a server-side routing concern.

## Acceptance Criteria

- `pipelineConfig` is optional; omitting it is backward-compatible
- Each stage uses the specified provider if present, falls back to `provider` if absent
- Provider API keys must be configured server-side for specified providers; returns `{"error":"provider_not_configured"}` if key missing
- Cost breakdown per stage returned in `complete` event: `{"stageCosts": {"extraction": 0.002, "verification": 0.048, "synthesis": 0.06}}`
- Works with both `POST /scan` (JSON) and `POST /scan/stream` (SSE)
- Invalid `ProviderName` values return 400 with `{"error":"invalid_provider","provider":"..."}`
