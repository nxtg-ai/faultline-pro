# @nxtg/faultline-mcp

**Your AI says "done." Faultline checks what it told you.**

An [MCP](https://modelcontextprotocol.io) server that verifies the factual claims in agent output against live sources — inside Claude Code, Cursor, Windsurf, or any MCP client.

Agents assert things that aren't true, confidently, in the exact register that reads as competence. This puts a check at the point the assertion is made.

---

## Install

**Claude Code**

```bash
claude mcp add faultline -- npx -y @nxtg/faultline-mcp
```

**Cursor / Windsurf** — add to your MCP config:

```json
{
  "mcpServers": {
    "faultline": {
      "command": "npx",
      "args": ["-y", "@nxtg/faultline-mcp"],
      "env": { "GEMINI_API_KEY": "your-key" }
    }
  }
}
```

## Provider key

Verification runs against a model provider using **your own key** — nothing is proxied through a hosted service.

```bash
export GEMINI_API_KEY="..."   # free key: https://aistudio.google.com/apikey
```

**Use Gemini.** It is the only provider that retrieves live sources during verification (via the `googleSearch` tool). The others judge from the model's own knowledge and return verdicts with **no evidence behind them**. The server tells you which mode you are in — `grounded: false` on the response, and a warning on startup:

```
faultline-mcp ready — provider: openai (NOT GROUNDED). This provider judges claims
from model knowledge without retrieving sources, so verdicts carry no evidence.
```

Provider precedence: `FAULTLINE_PROVIDER` → `GEMINI_API_KEY` → `OPENAI_API_KEY` → `ANTHROPIC_API_KEY` → `PERPLEXITY_API_KEY` → `mock`.

With no key at all the server runs the `mock` provider, which returns **synthetic results and verifies nothing**. It exists for CI wiring, not for use.

## Tool: `verify_claims`

**Input**

| field | type | notes |
|---|---|---|
| `text` | string | required — the text whose claims should be checked |
| `max_claims` | int | optional — return at most N claims, most-important first |
| `provider` | enum | optional — `gemini` \| `openai` \| `claude` \| `perplexity` \| `mock` |

**Verdicts**

| verdict | meaning |
|---|---|
| `VERIFIED` | supported by sources |
| `REFUTED` | contradicted by sources |
| `UNSUPPORTED` | checked, no supporting evidence found |
| `MIXED` | evidence both supports and contradicts |
| `UNCHECKED` | **not a verdict** — verification did not run |

`UNCHECKED` is deliberately not folded into `UNSUPPORTED`. "We never checked" and "we checked and found nothing" are opposite statements, and collapsing them makes a rate-limit or an expired key look like a caught hallucination. `unchecked_reason` says which it was: `provider_error` or `not_verifiable` (opinions and non-factual statements are not checkable).

**Response fields that matter**

- `degraded` — one or more claims could not be checked. **Not a clean bill of health.**
- `risk_score` — 0-100, or **`null`** when not a single claim got a real verdict. A scan that checked nothing has no risk reading.
- `grounded` — whether sources were actually retrieved.
- `unsourced_count` — real verdicts carrying no source URL.
- `audit_ref` / `audit_path` — pointer to the persisted evidence record. Omitted rather than faked when nothing was written.

**Example**

```json
{
  "risk_score": 75,
  "overall_risk": "high",
  "provider": "Google Gemini",
  "grounded": true,
  "claims": [
    {
      "claim": "The Great Wall of China is visible from the Moon with the naked eye.",
      "verdict": "REFUTED",
      "evidence_url": "https://...",
      "evidence_urls": ["https://..."],
      "note": "Not visible from the Moon; too narrow against the surrounding terrain."
    }
  ],
  "claims_total": 3,
  "degraded": false,
  "unchecked_count": 0,
  "audit_ref": "fl_fb611b5d3870c93a",
  "summary": "3 claims — 2 VERIFIED, 1 REFUTED · risk HIGH"
}
```

## Scope in v1

Verifies **informational** claims — statements about the world that sources can settle.

It does **not** verify **operational** claims like "the tests pass," "it's deployed," or "the migration ran." Those need deterministic probes against your own systems, not source retrieval. Asking a language model whether your tests passed reproduces the problem this tool exists to catch.

`verify_url` is not implemented: the underlying engine has no URL-ingestion path today, and this package is a wrapper — it does not add engine capabilities.

## Audit records

Each verification writes a JSON record to `.faultline/history/` (override with `FAULTLINE_HISTORY_DIR`, disable with `FAULTLINE_MCP_NO_HISTORY=1`). `audit_ref` is the record's id and `audit_path` its location — if the write fails, both are omitted and `audit_skipped` explains why, rather than handing back a reference that resolves to nothing.

## Related

- [`@nxtg/faultline`](https://www.npmjs.com/package/@nxtg/faultline) — the CLI, including `faultline guard` for piping agent output through the same check
- [faultline.nxtg.ai](https://faultline.nxtg.ai) — hosted scanning

## Not affiliated with fltln.io

The unscoped `faultline-mcp` package on npm belongs to fltln.io, an unrelated incident-monitoring company. This package is `@nxtg/faultline-mcp` (scoped), from NXTG.AI. No affiliation, no relationship.

## License

Apache-2.0
