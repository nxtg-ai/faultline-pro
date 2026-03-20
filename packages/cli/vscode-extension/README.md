# Faultline VS Code Extension

Inline AI claim forensics in your editor. Scan any document for unverified claims, hallucinations, and EU AI Act risk.

## Features

- **Inline diagnostics** — yellow warnings on unverified claims, errors on high-risk content
- **Scan on save** — automatically scans `.md`, `.txt`, `.json` files when saved
- **Right-click scan** — context menu > "Scan with Faultline"
- **Keyboard shortcut** — `Ctrl+Shift+F` (Cmd+Shift+F on Mac)
- **5 AI providers** — Gemini, OpenAI, Claude, Perplexity, Mock (no key required)

## Setup

1. Install the extension from VS Code Marketplace
2. Set your provider API key in VS Code settings or as an env var:
   ```json
   { "faultline.provider": "gemini" }
   ```
3. Set `GEMINI_API_KEY` in your shell environment
4. Open a Markdown or text file and press `Ctrl+Shift+F`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `faultline.scanOnSave` | `true` | Auto-scan on file save |
| `faultline.provider` | `mock` | AI provider |
| `faultline.minConfidence` | `0` | Min confidence threshold |
| `faultline.rules` | `[]` | Rules (pii, toxicity, bias) |

## Requirements

- VS Code 1.85+
- Node 20+
- `@nxtg/faultline` installed globally or as project dependency
