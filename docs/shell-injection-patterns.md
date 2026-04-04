# Shell Injection Detection Patterns

> Documented: 2026-04-02 — N-203 post-ship pattern record  
> Relevant files: `packages/cli/rules/yaml/shell-injection.yaml`, `packages/cli/rules/shell_injection_rule.ts`

## Why This Exists

AI-assisted development tools are a primary target for prompt injection attacks that embed shell commands in generated text. A user who copies an AI response into a terminal, or a CI pipeline that pipes AI output directly to `sh`, is vulnerable without detection.

Faultline's shell injection detection operates on two layers: **YAML regex patterns** (syntactic, fast) and a **TypeScript Unicode rule** (semantic, catches obfuscation). Both layers run as part of `--rules shell-injection` and are also executed automatically in `runAllRules()`.

---

## Layer 1: YAML Regex Patterns (`shell-injection.yaml`)

12 patterns covering the top prompt-injection shell vectors:

| Pattern | Severity | Regex trigger | Rationale |
|---------|----------|---------------|-----------|
| `command-substitution-dollar` | high | `$(...)`| Executes arbitrary command inline; most common copy-paste vector |
| `command-substitution-backtick` | high | `` `...` `` | Legacy form of `$(...)`, still executed by all POSIX shells |
| `ifs-injection` | critical | `IFS=` | Redefines field separator; bypasses space-based security checks, enables command smuggling |
| `eval-exec` | critical | `eval`/`exec` + quote/`$` | Dynamic argument execution — expands any string as a shell command |
| `base64-decode-pipe` | critical | `base64 -d \| sh` | Obfuscates payload as base64; evades content filters that scan for known bad strings |
| `curl-pipe-shell` | critical | `curl`/`wget` + `\| sh` | Fetches and executes remote code in one command; classic supply chain vector |
| `dangerous-rm-root` | critical | `rm -rf /` / `rm ~/*` | Recursive deletion of root, home, or wildcard paths |
| `env-var-override-path` | high | `PATH=` / `LD_PRELOAD=` / `LD_LIBRARY_PATH=` | Hijacks command resolution or dynamic linker; enables binary substitution attacks |
| `process-substitution` | medium | `<(...)` / `>(...)` | Bash-specific; executes command via file-descriptor redirection, less common but valid attack surface |
| `hidden-semicolon-chain` | high | `; curl` / `; rm` etc. | Hides malicious command after a benign one; relies on users reading only the first command |
| `dd-overwrite` | critical | `dd of=/dev/sd*` | Writes directly to raw disk device; can corrupt or overwrite filesystem |
| `mkfifo-pipe-exec` | critical | `mkfifo` + `sh`/`nc` | Named pipe with shell or netcat — reverse shell pattern |

### Design notes

- All patterns use `flags: "g"` (global) for multi-occurrence detection.
- `base64-decode-pipe` and `curl-pipe-shell` use `flags: "gi"` (case-insensitive) because `CURL`, `WGET`, `SH` are valid capitalizations in some scripts.
- `dangerous-rm-root` uses `flags: "gm"` (multiline) so `$` anchors match end-of-line, not just end-of-string.
- Regex patterns are intentionally kept simple (no lookbehind) for compatibility with the YAML regex engine.

---

## Layer 2: TypeScript Unicode Detection (`shell_injection_rule.ts`)

Regex cannot detect text that *looks* like ASCII but uses Unicode confusables, invisible characters, or bidirectional overrides. The TypeScript rule scans code-point by code-point for four categories:

### Zero-width characters
9 code points: U+200B (zero-width space) through U+2064 (invisible plus) + U+FEFF (BOM).

**Attack vector**: Insert a zero-width character inside a shell command keyword (`c​url` with U+200B between `c` and `u`). The command *looks* benign to a human reviewer but executes normally in terminals that strip zero-width characters, or fails to trigger regex patterns that match the full string.

### Bidirectional override characters
9 code points: U+202A–U+202E (embedding/override) + U+2066–U+2069 (isolate/pop).

**Attack vector**: RTL override (U+202E) reverses displayed text direction. A command like `elifkcab` displayed with RTL override appears as `backfile` to a reviewer but the underlying bytes are `elifkcab`. This is the **Trojan Source** attack ([CVE-2021-42574](https://trojansource.codes/)).

### Unicode whitespace variants
18 code points: U+00A0 (no-break space) through U+3000 (ideographic space), excluding ASCII space/tab/newline.

**Attack vector**: Replace ASCII spaces in a shell command with no-break spaces (U+00A0). Regex patterns matching ` sh` (ASCII space + sh) won't fire; terminals often treat no-break space as a word separator and execute the command normally.

### Latin homoglyphs (Cyrillic/Greek)
High-risk confusables where Cyrillic or Greek characters are visually identical to Latin:
- **Cyrillic**: А(U+0410)→A, В→B, С→C, Е→E, Н→H, К→K, М→M, О→O, Р→P, Т→T, Х→X, У→Y
- **Greek**: Α(U+0391)→A, Β→B, Ε→E, Ζ→Z, Η→H, Ι→I, Κ→K, Μ→M, Ν→N, Ο→O, Ρ→P, Τ→T, Υ→Y, Χ→X

**Attack vector**: Substitute Latin letters in shell keywords with visually identical Cyrillic/Greek. `curl` written with Cyrillic С+u+r+l passes string equality checks (`'curl' !== 'Сurl'`) but displays identically in most fonts.

### Coverage gap: astral-plane homoglyphs
The TypeScript rule handles code points in the Basic Multilingual Plane (U+0000–U+FFFF). Surrogate pair handling for astral-plane code points (U+10000+) exists in the code (lines 176–183) but has no test fixtures. Coverage: 93.93% statements on this file. This is an accepted low-risk gap — high-risk Latin confusables are in the BMP.

---

## Integration

```bash
# Run shell injection rules only
faultline scan --input output.txt --rules shell-injection

# Combined with other security rules
faultline scan --input output.txt --rules shell-injection,pii,toxicity

# In CI — fail on high or critical findings
faultline scan --input ai-output.txt --rules shell-injection --fail-on high
```

Both rule layers are invoked together when `shell-injection` is in the `--rules` list. The YAML engine runs first (fast regex pass); the TypeScript Unicode rule runs second (code-point scan).

---

## Mutation Testing Status (Gate 6)

- `shell_injection_rule.ts`: 93.93% statement coverage, **mutation score not yet run** (Stryker config at `packages/cli/stryker.config.mjs` — not yet committed to git as of N-203)
- The YAML pattern tests cover all 12 patterns with positive and negative fixtures
- Astral-plane surrogate-pair paths (lines 176–183) are the one uncovered branch; would require Unicode code points > U+FFFF in test fixtures

---

## References

- [Trojan Source — CVE-2021-42574](https://trojansource.codes/) — Bidi override attack
- [Unicode Confusables](https://www.unicode.org/reports/tr39/#Confusable_Detection) — Unicode TR39 §4
- [OWASP Prompt Injection (A01:2026 Agentic)](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — shell injection as LLM attack vector
- [Claude Code shell security layer](https://github.com/anthropics/claude-code) — inspiration for the 9-category Unicode check (zero-width, bidi, control chars, homoglyphs, whitespace variants, escape sequences)
