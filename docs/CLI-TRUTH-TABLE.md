# CLI Truth Table — `@nxtg/faultline`

> **Source of truth for FW docs rewrite.**
> Every entry verified by execution on 2026-04-17 against `v0.5.2`.
> `✅ Works` = executed, exit 0, expected output observed.
> `⚠️ Conditional` = works but requires API key, running FP server, or specific input type.
> `ℹ️ Note` = behavioural quirk FW docs must document accurately.

Binary: `faultline` (or `node packages/cli/bin/faultline.js`)

---

## Identity

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `version` | — | ✅ | Prints `Faultline v0.5.2` |
| `--version` | — | ✅ | Alias for `version` |
| `-v` | — | ✅ | Alias for `version` |
| `help` | — | ✅ | Prints full usage block |
| `--help` | — | ✅ | Alias for `help` |
| `-h` | — | ✅ | Alias for `help` |

---

## `scan`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `scan` | `--input <file>` | ✅ | Requires `--provider` or `GEMINI_API_KEY` / other key |
| `scan` | `--input <file> --provider mock` | ✅ | Self-contained; no API key required |
| `scan` | `--input <file> --provider gemini\|claude\|openai\|perplexity` | ⚠️ | Requires corresponding `*_API_KEY` env var |
| `scan` | `--input <file> --output-format json` | ✅ | Outputs JSON to stdout |
| `scan` | `--input <file> --output-format markdown` | ✅ | Outputs Markdown to stdout |
| `scan` | `--input <file> --output-format html` | ✅ | Outputs HTML to stdout |
| `scan` | `--input <file> --output-format sarif` | ✅ | Outputs SARIF JSON to stdout |
| `scan` | `--input <file> --sarif` | ✅ | **Writes `results.sarif` to CWD** AND outputs SARIF to stdout. ℹ️ Not stdout-only — file is written. |
| `scan` | `--input <file> --rules pii,bias,toxicity,shell-injection,yaml-bias,yaml-pii,yaml-security,yaml-shell-injection` | ✅ | Comma-separated; any subset valid |
| `scan` | `--input <file> --min-confidence 0.0–1.0` | ✅ | Float filter; low-confidence claims skipped |
| `scan` | `--input <file> --fail-on critical\|high\|medium\|low` | ✅ | Exits 1 when overall risk ≥ threshold. ℹ️ Mock always returns LOW so exit is 0 in tests |
| `scan` | `--input <file> --history-dir <path>` | ✅ | Saves scan JSON to `<path>/` instead of default history dir |
| `scan` | `--input <file> --lang <code>` | ✅ | Sets output language (e.g. `en`) |
| `scan` | `--demo` | ✅ | Self-contained demo; no API key; no `--input` needed |
| `scan` | `--dir <path>` | ✅ | Batch mode; scans all text files in dir |
| `scan` | `--dir <path> --glob "*.txt"` | ✅ | Only scans files matching glob |
| `scan` | `--dir <path> --provider mock` | ✅ | |
| `scan` | `--file <path>` | ⚠️ | PDF/image upload to provider vision API. **Supported types: `.pdf .png .jpg .jpeg .webp` only.** ℹ️ `.txt` and `.md` rejected with "Unsupported file type" |
| `scan` | `--templates <categories>` | ✅ | Red-team mode; comma-separated categories (e.g. `injection,bias`). No `--input` needed. |
| `scan` | `--template <name>` | ⚠️ | Loads named template from `.faultlinerc.json`. ℹ️ If template not found, prints usage error (no "not found" message — silent fallback). Requires `.faultlinerc.json` with matching template entry. |

---

## `report`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `report` | `--input <results.json>` | ✅ | Reformats saved scan JSON; outputs Markdown by default |
| `report` | `--input <file> --output-format json\|markdown\|html\|sarif` | ✅ | All formats confirmed working |

---

## `aggregate`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `aggregate` | `--dir <path>` | ✅ | Aggregates all `*.json` scan files in dir; outputs JSON summary |
| `aggregate` | `--dir <path> --output-format json\|markdown\|html\|sarif` | ✅ | |

---

## `watch`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `watch` | `--dir <path>` | ✅ | Long-running; watches dir for file changes; Ctrl+C to stop |
| `watch` | `--dir <path> --provider mock --output-format json\|markdown\|html\|sarif --rules <list> --min-confidence <float>` | ✅ | All flags confirmed present; same behaviour as `scan --dir` per change event |

---

## `history`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `history` | — | ✅ | Shows last 20 scans (default) |
| `history` | `--all` | ✅ | Shows all history entries |
| `history` | `--history-dir <path>` | ✅ | Reads from alternate history dir |

---

## `trend`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `trend` | `--file <path>` | ✅ | Shows finding trend for a specific file across scan history. ℹ️ Requires ≥2 scans for trend data; shows "Insufficient data" for single scan |
| `trend` | `--file <path> --history-dir <path>` | ✅ | |

---

## `weakest`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `weakest` | `--input <scan.json>` | ✅ | Identifies fragile claims by resilience score |
| `weakest` | `--input <scan.json> --provider mock --min-confidence <float> --top <N>` | ✅ | `--top` defaults to 5 |

---

## `graph`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `graph` | `--input <scan.json>` | ⚠️ | **Default provider is auto-detected (gemini).** Requires `GEMINI_API_KEY` if no `--provider` flag. |
| `graph` | `--input <scan.json> --provider mock` | ✅ | Outputs Mermaid diagram to stdout |
| `graph` | `--input <scan.json> --format mermaid --provider mock` | ✅ | |
| `graph` | `--input <scan.json> --format dot --provider mock` | ✅ | Outputs Graphviz DOT to stdout |

---

## `critique`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `critique` | `--input <scan.json>` | ⚠️ | Defaults to gemini; requires API key |
| `critique` | `--input <scan.json> --provider mock` | ✅ | Outputs critique + improved prompt suggestions |
| `critique` | `--input <scan.json> --min-confidence <float>` | ✅ | |

---

## `compare`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `compare` | `--before <text\|file> --after <text\|file>` | ⚠️ | Defaults to auto-detect provider; requires key |
| `compare` | `--before <file> --after <file> --provider mock` | ✅ | Side-by-side scan diff; text output |
| `compare` | `--before <file> --after <file> --provider mock --output-format json` | ✅ | |
| `compare` | `--before <file> --after <file> --provider mock --output-format text` | ✅ | Default |

---

## `export`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `export` | — | ✅ | CSV to stdout; all history |
| `export` | `--format csv\|json\|ndjson` | ✅ | All three formats confirmed |
| `export` | `--from <ISO_DATE> --to <ISO_DATE>` | ✅ | Date range filter |
| `export` | `--output <file>` | ✅ | Writes to file; prints "Exported N scan(s)" |
| `export` | `--risk critical\|high\|medium\|low` | ✅ | Filters by risk level |
| `export` | `--provider <name>` | ✅ | Filters by provider |
| `export` | `--history-dir <path>` | ✅ | Reads from alternate history dir |

---

## `init`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `init` | — | ✅ | Writes `.faultlinerc.json` to CWD |
| `init` | `--dir <path>` | ✅ | Writes `.faultlinerc.json` to specified dir |

---

## `rules`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `rules` | — | ✅ | Lists all 8 built-in rules with descriptions |

---

## `templates`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `templates list` | — | ✅ | Lists all 15 red-team templates across 5 categories |
| `templates list` | `--category <name>` | ✅ | Filters by category (e.g. `injection`, `bias`, `hallucination`) |

---

## `compliance-report`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `compliance-report` | `--input <scan.json>` | ✅ | JSON output to stdout; EU AI Act evidence report |
| `compliance-report` | `--input <scan.json> --format json` | ✅ | |
| `compliance-report` | `--input <scan.json> --format markdown` | ✅ | |
| `compliance-report` | `--input <scan.json> --format sarif` | ✅ | |
| `compliance-report` | `--input <scan.json> --format html` | ✅ | ℹ️ **Writes to a local file** (`eu-compliance-report-<id>.html`) in CWD — NOT stdout. Use `--output <file>` for explicit path. |
| `compliance-report` | `--input <scan.json> --format pdf --output <file>` | ✅ | Writes PDF to specified path |
| `compliance-report` | `--input <scan.json> --output <file>` | ✅ | Writes to file |
| `compliance-report` | `--text <text> --provider mock` | ✅ | Runs fresh scan inline then generates report |
| `compliance-report` | `--diff before.json,after.json` | ✅ | Comma-separated two-file diff; shows improved/regressed articles |
| `compliance-report` | `--project-name <string>` | ✅ | Sets `projectName` in report |
| `compliance-report` | `--input <scan.json> --ci` | ✅ | Exit 0 = PASS; Exit 1 = FAIL (any non-compliant article) |
| `compliance-report` | `--input <scan.json> --ci --threshold <N>` | ✅ | Exit 1 only when non-compliant article count ≥ N |
| `compliance-report` | `--input <scan.json> --ci --strict` | ✅ | ℹ️ **Exits 1 for PARTIAL articles** (not just FAIL). Stricter than default `--ci`. |
| `compliance-report` | `--config <path>` | ✅ | Loads compliance config file |

---

## `stats`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `stats` | `--package <name>` | ✅ | Fetches npm download stats for package (last 7 days + trend) |
| `stats` | `--package <n1> --package <n2>` | ✅ | Repeatable flag; multi-package comparison |
| `stats` | `--no-save` | ✅ | Skips persisting snapshot |
| `stats` | `--snapshot-path <path>` | ✅ | Custom snapshot storage path |

---

## `stream`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `stream <text>` | `--api-url <URL> --api-key <KEY>` | ⚠️ | **Requires running FP API server** (`packages/api`). Connects to `POST /scan/stream` (SSE). `--api-key` or `FAULTLINE_API_KEY` required. |
| `stream <text>` | `--text <text>` | ⚠️ | Alternative to positional arg |
| `stream <text>` | `--provider mock` | ⚠️ | Provider hint forwarded to server |

---

## `plugin`

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `plugin list` | — | ✅ | Lists loaded plugins (empty if none installed) |
| `plugin install <pkg>` | — | ⚠️ | Runs `npm install <pkg>` under the hood. ℹ️ Exit 0 even if npm install fails (e.g. 404 package). Check output for npm errors. |
| `plugin remove <pkg>` | — | ⚠️ | Runs `npm uninstall <pkg>`. ℹ️ Exit 0 even if package not installed. |

---

## `keys` (requires FP API server)

All `keys` subcommands require a running FP API server (`packages/api`) and authenticate via `--api-key` or `FAULTLINE_API_KEY`. Default `--api-url` is `http://localhost:3000`. **Without a server, commands print an error and exit 0.**

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `keys list` | `--api-url --api-key` | ⚠️ | Lists all API keys |
| `keys dormant` | `--days 30 --api-url --api-key` | ⚠️ | Lists keys unused for N days |
| `keys expiring` | `--days 7 --api-url --api-key` | ⚠️ | Lists keys expiring within N days |
| `keys rotate <id>` | `--api-url --api-key` | ⚠️ | Rotates a specific key by ID |
| `keys rotation` | `--days 90 --api-url --api-key` | ⚠️ | ℹ️ `--days` capped at 365 |
| `keys prune` | `--days 90 --api-url --api-key` | ⚠️ | Dry-run by default. Add `--confirm` to execute deletion. ℹ️ `--days` capped at 365. |

---

## `scans` (requires FP API server)

Same server requirement as `keys`. All exit 0 on connection failure.

| Command | Flags | Works | Notes |
|---------|-------|-------|-------|
| `scans stale` | `--days 30 --api-url --api-key` | ⚠️ | Lists scan groups with no activity for N days |
| `scans usage` | `--staleDays 30 --api-url --api-key` | ⚠️ | ℹ️ Flag is `--staleDays` (camelCase), not `--stale-days` |
| `scans prune` | `--days 30 --api-url --api-key` | ⚠️ | Dry-run by default. Add `--confirm` to execute. |

---

## Behavioural Notes for FW Docs

The following behaviours were found to differ from what docs might imply:

| # | Finding |
|---|---------|
| 1 | **`scan --sarif`** (boolean): writes `results.sarif` to **CWD**, not stdout-only. Docs must warn users running from project root. |
| 2 | **`scan --template <name>`**: silently falls back to usage error when template not found in `.faultlinerc.json`. No "template not found" message. |
| 3 | **`scan --file`**: only `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp` supported. `.txt`/`.md` rejected. |
| 4 | **`graph`**: defaults to auto-detected provider (gemini if key present). Must specify `--provider mock` for keyless use. |
| 5 | **`compliance-report --format html`**: writes to auto-named file in CWD, not stdout. Other formats output to stdout. Use `--output <file>` for explicit path. |
| 6 | **`compliance-report --ci --strict`**: exits 1 for `PARTIAL` articles, not just fully `FAIL` ones. Stricter than plain `--ci`. |
| 7 | **`plugin install/remove`**: always exits 0 regardless of npm outcome. Check stdout for errors. |
| 8 | **`keys`/`scans`/`stream`**: require FP API server (`packages/api`), not faultline-web. `localhost:3000` is the default but that port may be used by faultline-web's Next.js dev server. |
| 9 | **`compare/graph/critique/weakest`**: no `--provider` defaults to auto-detected (gemini). Silently fail with API key error if key absent. |

---

*Verified: 2026-04-17 | v0.5.2 | Directive NXTG-20260416-02*
