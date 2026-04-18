# Live Scan Analysis — For FW Integration

**Date**: 2026-04-17
**Scan target**: `examples/financial-claims.txt` (17 lines, 6 paragraphs of AI-generated financial claims)
**Purpose**: First real end-to-end forensic scan using the FR-3 per-stage provider routing. This is the **reference payload** FW should use when wiring the UI to real backend responses.

---

## Pipeline Used (FR-3 Per-Stage Routing)

| Stage | Provider | Why |
|-------|----------|-----|
| Extract claims | OpenAI (GPT-5.4 Nano) | JSON-adherent, fast, cheap |
| Verify claims | Gemini 3 Flash | Native Google Search grounding |
| Synthesize (compliance + critique) | Claude Sonnet 4.6 | EU AI Act domain reasoning |

**API call**:

```bash
POST http://localhost:3010/scan
x-api-key: <FAULTLINE_API_KEY>

{
  "text": "<AI-generated doc>",
  "pipelineConfig": {
    "extractionProvider": "openai",
    "verificationProvider": "gemini",
    "synthesisProvider": "claude"
  }
}
```

---

## Observed Timing

**Total wall time: 147.64s (≈2.5 min)** for an 8-claim document.

Compare against demo mode: ~2s. The demo uses baked fixtures — FW should expect real scans to take 1.5–3 minutes depending on claim count and provider load. For realistic UX:

- Show progress via SSE (`POST /scan/stream`) instead of blocking POST `/scan`
- Surface per-claim verification progress (claim N of M verified)
- Expect ~10–20s per claim on the verify stage

---

## Response Shape (Top-Level)

See `2026-04-17-financial-claims-per-stage.json` for the full payload. Key top-level fields:

```ts
{
  input: string;                  // original text
  provider: string;               // "OpenAI" — which provider did extraction (single-name, not per-stage map)
  claims: Claim[];                // 8 atomic claims
  verifications: Record<id, Verification>;  // keyed by claim.id
  overallRisk: 'low' | 'medium' | 'high' | 'critical';  // "high"
  complianceReport: ComplianceReport;  // full EU AI Act object
  complianceScore: number;        // 0–100 — 69
  compliancePass: boolean;        // false
  ruleFindings: RuleFinding[];    // 0 on this scan
}
```

**Gap flagged**: FR-3 specifies `stageCosts` and `timings` per-stage in the response. **Both are NOT returned by the current engine.** If FW is building a "cost per scan" or "stage timing breakdown" panel, the backend needs an enhancement — filed as a follow-up to FR-3.

---

## Claim + Verification Shape

**Claim**:
```ts
{
  id: string;           // "c1", "c2", ... "s7", "s8"
  text: string;         // the atomic claim
  type: 'fact' | 'opinion' | 'interpretation';
  importance: number;   // 1–5
}
```

**Verification**:
```ts
{
  claimId: string;
  status: 'supported' | 'contradicted' | 'mixed' | 'unverified';
  explanation: string;  // LLM-written reasoning
  sources?: Array<{
    title: string;      // e.g., "federalreserve.gov"
    uri: string;        // ⚠ see caveat below
  }>;
}
```

### ⚠ Source URI Caveat — Gemini Redirect Wrapping

All `sources[].uri` values from the Gemini verification stage are **opaque Vertex AI redirect URLs**:

```
https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHDDVNADlTBV...
```

These are **not the final target URL** — they're Google's redirect tracking wrappers. For UI display:

- **Option A (recommended)**: Follow the redirect server-side before returning the response, replace `uri` with the resolved target URL. Title (`sources[].title`) already contains the publisher domain (`capital.com`, `federalreserve.gov`, etc.) for display purposes.
- **Option B**: Display the title as the clickable label, link to the redirect URL (works but user sees `vertexaisearch.cloud.google.com` on hover).
- **Option C (do not do)**: Strip redirect URLs — loses provenance entirely.

Whichever path FW chooses, surface it as a backlog item — the current behaviour is semantically correct but visually jarring.

---

## Risk + Compliance Structure

```ts
overallRisk: 'high'          // top-level
complianceScore: 69          // 0–100, top-level
compliancePass: false        // top-level, boolean

complianceReport: {
  generatedAt: string;
  overallRiskLevel: 'high';
  euRiskSummary: { /* ... */ };
  claimMappings: ClaimMapping[];
  triggeredArticles: string[];    // e.g., ['Article 9', 'Article 10', ...]
  mitigations: Mitigation[];
  confidenceDistribution: { /* ... */ };
}
```

For FW's compliance-gate UI: use `compliancePass` (true/false) as the gate decision, `complianceScore` (0–100) for the visual gauge, `triggeredArticles` for the article-badge list, `mitigations` for the action-item panel.

---

## Sample Verdict (One of Eight)

```json
{
  "claimId": "c2",
  "status": "contradicted",
  "explanation": "A backtested Sharpe ratio of 1.42 is generally considered 'good,' but not typically in the 'top decile' for comparable systematic strategies over the 2015-2025 period. Top-tier Sharpe ratios for such systematic strategies are generally in the range of 2.0 or higher...",
  "sources": [
    { "title": "schwab.com", "uri": "<redirect>" },
    { "title": "wallstreetoasis.com", "uri": "<redirect>" }
  ]
}
```

This is **real forensics** — Gemini found contradiction evidence from current financial sources and the synthesizer correctly classified it as `contradicted`.

---

## Verdict Distribution on This Scan

| Verdict | Count | Color Code (suggested) |
|---------|-------|------------------------|
| supported | 1 | green |
| contradicted | 2 | red |
| mixed | 4 | orange |
| unverified | 1 | gray |

Overall risk: **HIGH** (contradicted claims present).
Compliance: **FAIL** (score 69, below default threshold).

---

## Files in This Directory

| File | Purpose |
|------|---------|
| `2026-04-17-financial-claims-per-stage.json` | Full raw scan response — use as fixture/reference payload |
| `2026-04-17-financial-claims-scan-report.html` | Scan report (claim-by-claim) — canonical HTML |
| `2026-04-17-financial-claims-scan-report.pdf` | Same, rendered to PDF via headless Chrome |
| `2026-04-17-financial-claims-scan-report.md` | Markdown variant (for PR comments) |
| `2026-04-17-financial-claims-compliance-report.html` | EU AI Act compliance report — canonical HTML |
| `2026-04-17-financial-claims-compliance-report.pdf` | Same, rendered to PDF via headless Chrome |

## PDF Generation Note

**The PDF files in this directory were rendered via headless Chrome** (`google-chrome --headless --print-to-pdf`), not via the CLI's native `pdfkit` output. The `pdfkit` path in `packages/cli/cli/compliance-report.ts` (`renderComplianceReportPdf`) has a severe layout bug: article blocks overlap, pages 2/5/7 render blank with orphan footers, and Unicode symbols (`→`, `·`) render as `!'` mojibake. **Filed as follow-up** — do not use `--format pdf` on the CLI for customer-facing PDFs until that's fixed; render HTML via Chrome headless instead.
