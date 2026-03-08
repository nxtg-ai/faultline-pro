# Faultline Provider Reference

Faultline supports 5 LLM providers via a clean `LLMProvider` interface. Switch providers with `--provider <name>`.

## Provider Comparison

| Provider | Key Source | Env Var | Default Model | Search Capability | Best For |
|----------|-----------|---------|---------------|-------------------|----------|
| `gemini` | [Google AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` | `gemini-2.5-flash` | Google Search grounding | Free tier, EU compliance, production |
| `claude` | [Anthropic Console](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | ❌ Training data only | Nuanced reasoning, long documents |
| `openai` | [OpenAI Platform](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` | `gpt-5-mini` | ❌ Training data only | General use, low cost |
| `perplexity` | [Perplexity API](https://www.perplexity.ai/settings/api) | `PERPLEXITY_API_KEY` | `sonar-pro` | ✅ Real-time web search | High-accuracy fact verification |
| `mock` | None | None | N/A | N/A | CI/CD, testing, local dev |

> **Search Gap**: Claude and OpenAI verify claims from training data only — they cannot search the live web. Gemini uses Google Search grounding. Perplexity is search-native with 93.9% SimpleQA accuracy. For highest verification accuracy on current facts, use `--provider perplexity` or `--provider gemini`.

## Provider Details

### Gemini (`--provider gemini`)

- **API Key**: [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — free tier available, no credit card required
- **Env Var**: `GEMINI_API_KEY`
- **Default Model**: `gemini-2.5-flash`
- **Model Override**: `FAULTLINE_GEMINI_MODEL` env var
- **Search**: Google Search grounding built-in — verifies claims against live web data
- **Special Behavior**: Thin adapter over `geminiService.ts`; all extraction, verification, and critique logic lives in that service module. The Gemini provider is the default when no `--provider` flag or `FAULTLINE_PROVIDER` env var is set.

```bash
export GEMINI_API_KEY="your-key"
npx @nxtg/faultline scan --input doc.txt --provider gemini
```

### Claude (`--provider claude`)

- **API Key**: [console.anthropic.com](https://console.anthropic.com/)
- **Env Var**: `ANTHROPIC_API_KEY`
- **Default Model**: `claude-sonnet-4-6`
- **Model Override**: `FAULTLINE_CLAUDE_MODEL` env var
- **Search**: None — verification is based on training data only
- **Special Behavior**: Uses the Anthropic Messages API (`/v1/messages`) with `anthropic-version: 2023-06-01`. Supports image inputs (base64). JSON extraction handles markdown code blocks and raw JSON in responses. Max tokens: 4096 per call.

```bash
export ANTHROPIC_API_KEY="your-key"
npx @nxtg/faultline scan --input doc.txt --provider claude
```

### OpenAI (`--provider openai`)

- **API Key**: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Env Var**: `OPENAI_API_KEY`
- **Default Model**: `gpt-5-mini`
- **Model Override**: `FAULTLINE_OPENAI_MODEL` env var
- **Search**: None — verification is based on training data only
- **Special Behavior**: Uses the Chat Completions API (`/v1/chat/completions`) with `response_format: { type: "json_object" }` for reliable structured output. Supports image inputs via `image_url` content blocks.

```bash
export OPENAI_API_KEY="your-key"
npx @nxtg/faultline scan --input doc.txt --provider openai
```

### Perplexity (`--provider perplexity`)

- **API Key**: [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
- **Env Var**: `PERPLEXITY_API_KEY`
- **Default Model**: `sonar-pro`
- **Model Override**: `FAULTLINE_PERPLEXITY_MODEL` env var
- **Search**: Real-time web search native — Perplexity retrieves live evidence for every claim
- **Special Behavior**: Citations are automatically extracted from Perplexity's response and surfaced as `sources` in each `VerificationResult`. This is the only provider (besides Gemini) that can verify claims about recent events beyond model training cutoffs. Achieves 93.9% SimpleQA accuracy.

```bash
export PERPLEXITY_API_KEY="your-key"
npx @nxtg/faultline scan --input doc.txt --provider perplexity
```

### Mock (`--provider mock`)

- **API Key**: None required
- **Env Var**: None
- **Default Model**: `mock-v1` (internal identifier, no real model)
- **Model Override**: Not applicable
- **Search**: None — fully offline, no network calls
- **Special Behavior**: Deterministic, offline provider for CI/CD and local development. Splits input text into sentence-based claims and returns `"supported"` for all verdicts with flat 0.30 confidence. All verdicts are predictable and reproducible — use it to validate pipeline shape, not to evaluate real claims.

```bash
# No API key needed
npx @nxtg/faultline scan --input doc.txt --provider mock
```
