# Faultline Pro — Go-to-Market Plan

**Version**: 0.1.0 npm launch
**Author**: Faultline-Pro team (P-08b) | **Date**: 2026-03-05
**Directive**: DIRECTIVE-NXTG-20260305-04 | **Status**: DRAFT

---

## 1. Positioning Statement

**"AI Claim Forensics — verify what AI actually said, not just how you prompted it."**

Promptfoo tests your prompts. DeepEval scores your RAG pipeline. Faultline decomposes AI output into atomic claims and stress-tests each one against live evidence, mapping findings to EU AI Act risk categories. It answers the question enterprise compliance teams actually care about: **"Did the AI lie, and does that violate regulation?"**

One-liner for npm: *The open-source CLI that decomposes AI-generated text into atomic claims, verifies each against live evidence, and maps findings to EU AI Act compliance tiers.*

---

## 2. npm Package Strategy

### Package Identity

- **Name**: `@nxtg/faultline` (already configured in package.json)
- **Version**: `0.1.0`
- **License**: CC-BY-4.0 (current). **GAP**: Consider switching to Apache-2.0 or MIT for broader adoption — CC-BY is unusual for software packages and may cause enterprise legal teams to pause. See Gap Analysis below.

### README Lead (EU AI Act angle)

The npm README should open with:

```
# Faultline — AI Claim Forensics

Verify AI-generated claims. Required by August 2026.

The EU AI Act mandates that high-risk AI systems undergo conformity
assessments. Faultline decomposes AI output into atomic claims,
stress-tests each against live evidence, and maps findings to
EU AI Act risk tiers — so you can ship with confidence, not hope.
```

Followed immediately by the hello-world command (see below), then the feature matrix showing what Faultline does that Promptfoo and DeepEval do not.

### Hello World (fastest path to value)

**Current state**: The quickest zero-config experience is:

```bash
npx @nxtg/faultline scan --input document.txt --provider mock
```

The `--provider mock` flag gives instant results without any API key setup. This is critical for the "try it in 10 seconds" experience.

**Recommended hello-world sequence for README and launch posts**:

```bash
# 1. Scan a document (no API key needed — mock provider)
echo "GPT-4 achieves 92% accuracy on medical diagnosis tasks" > claim.txt
npx @nxtg/faultline scan --input claim.txt --provider mock

# 2. See the EU AI Act compliance report
npx @nxtg/faultline scan --input claim.txt --provider mock --output-format markdown

# 3. Find the weakest claim in a document
npx @nxtg/faultline weakest --input claim.txt --provider mock

# 4. Visualize the claim dependency graph
npx @nxtg/faultline graph --input claim.txt --provider mock --format mermaid
```

**GAP**: `npx @nxtg/faultline` requires the bin entry to work after npm install. Currently `bin.faultline` points to `./bin/faultline.js` which shells out to `tsx cli/index.ts`. This needs testing end-to-end after `npm pack` to confirm the npx flow works. See Gap Analysis.

### npm Keywords (for discoverability)

Current keywords are good. Add these for better search coverage:

```json
[
  "ai-safety", "ai-trust", "llm-testing", "eu-ai-act",
  "claim-verification", "hallucination-detection", "ai-compliance",
  "ai-forensics", "ai-audit", "sarif", "red-team",
  "foundation-model", "openai", "anthropic", "gemini"
]
```

---

## 3. Launch Day Plan (Day 1)

### Channels

| Platform | Target Subreddit / Section | Post Style |
|----------|---------------------------|------------|
| Hacker News | Show HN | Technical, brief, let the tool speak |
| Reddit | r/MachineLearning | Research-adjacent framing |
| Reddit | r/artificial | Broader AI audience |
| Reddit | r/ExperiencedDevs | Developer tooling angle |
| Reddit | r/europrivacy | EU AI Act compliance angle |
| AI Safety communities | LessWrong, AI Alignment Forum | Verification/trust framing |
| Dev communities | dev.to, Hashnode | Tutorial-style announcement |

### Post Titles (platform-adapted)

**Hacker News** (Show HN):
- "Show HN: Faultline -- open-source CLI that decomposes AI claims and checks them against evidence"
- "Show HN: We built a forensic tool that breaks AI output into atomic claims and verifies each one"

**Reddit r/MachineLearning**:
- "We open-sourced a claim-level verification tool for LLM outputs -- decomposes text into atomic claims, verifies each, maps to EU AI Act risk tiers"

**Reddit r/ExperiencedDevs**:
- "Built an open-source CLI for verifying AI-generated claims in CI/CD -- SARIF output, GitHub Actions, EU AI Act compliance reports"

**Reddit r/artificial**:
- "Open-source tool that answers 'did the AI lie?' by decomposing output into individual claims and fact-checking each one"

**Reddit r/europrivacy**:
- "Open-source developer tool for EU AI Act compliance -- maps AI-generated claims to risk tiers automatically"

### Demo / GIF

Record a terminal GIF (using `asciinema` or `vhs`) showing:

1. `echo "GPT-4 achieves 92% accuracy on medical diagnosis" > claim.txt`
2. `npx @nxtg/faultline scan --input claim.txt --provider mock`
3. Show the JSON output with claims decomposed and risk levels assigned
4. `npx @nxtg/faultline scan --input claim.txt --provider mock --output-format markdown`
5. Show the formatted compliance report with EU AI Act article mappings

Keep it under 30 seconds. No music, no fluff. Terminal output speaks for itself.

---

## 4. First 30 Days

### Week 1: Launch + Engage

- **Day 1**: Publish to npm. Post on HN (Show HN) and Reddit (r/MachineLearning, r/artificial).
- **Day 1-2**: Monitor all threads. Respond to every comment within 4 hours. Be honest about limitations (mock provider gives instant results; real verification needs API keys). Accept feedback gracefully.
- **Day 3-5**: Post on r/ExperiencedDevs (developer tooling angle) and r/europrivacy (compliance angle). Cross-post to dev.to with a tutorial format.
- **Day 5-7**: Address any bugs or UX issues reported by early users. Ship patch releases quickly (signal responsiveness).

### Week 2: Comparison Content

- **Blog post**: "Faultline vs Promptfoo vs DeepEval — an honest comparison"
  - Frame: "They're great tools. They solve different problems. Here's when to use each."
  - Table: Features side-by-side (use the competitive brief matrix)
  - Be honest about where Promptfoo wins (red teaming depth, 40+ attack templates, ecosystem maturity) and where Faultline wins (claim forensics, EU AI Act, SARIF, confidence calibration)
  - Do NOT be salesy. The developer audience will punish anything that smells like marketing.
- **Coordinate with P-14** (nxtg-content-engine): Have the content engine draft the comparison post and the Journalist agent fact-check it. Meta-use of the portfolio.

### Week 3: EU AI Act Compliance Tutorial

- **Blog post / guide**: "How to audit AI-generated content for EU AI Act compliance using Faultline"
  - Walk through a real-world scenario: company uses GPT-4 for customer support, needs to verify claims before they reach users
  - Show: `faultline scan` -> claim decomposition -> risk tier mapping -> compliance report
  - Cover Articles 5, 6, 7 and Annex III in plain language
  - Include the GitHub Action setup for CI/CD compliance gates
- **Target audience**: CTOs, compliance officers, DevOps leads at EU-operating companies
- **Distribution**: LinkedIn (Asif's profile), dev.to, company blog

### Week 4: GitHub Action Integration Guide

- **Blog post**: "Add AI claim verification to your CI/CD pipeline in 5 minutes"
  - Show the GitHub Action configuration (N-10 already exists)
  - Demonstrate `--fail-on high` for gating deployments
  - SARIF upload to GitHub Code Scanning
  - Show the VS Code extension integration
- **Coordinate with P-14**: This becomes a recurring "Faultline Fridays" content series

### Ongoing (coordinate with P-14 nxtg-content-engine)

- P-14 has 4 agents (Analyst, Editorial, Journalist, Orchestrator) and is the first dx3 API consumer
- Content requests to P-14:
  1. Comparison post (Week 2) — Journalist agent researches, Editorial polishes
  2. EU AI Act compliance guide (Week 3) — Analyst pulls regulatory data
  3. CI/CD integration tutorial (Week 4) — technical walkthrough
  4. Monthly "State of AI Trust" digest — ongoing content flywheel

---

## 5. Gap Analysis for v0.1.0

### Critical (must fix before npm publish)

| Gap | Impact | Effort |
|-----|--------|--------|
| **npx end-to-end test**: `npm pack` then `npx @nxtg/faultline scan` has not been validated. The `bin/faultline.js` entry shells out to `tsx cli/index.ts`, which may fail if `tsx` is not bundled. The `files` array in package.json includes `cli/` and `bin/` but these are TypeScript — consumers need `tsx` as a runtime dep. | Users get a broken first experience | S |
| **`tsx` is a runtime dependency**: Listed in `dependencies` (good), but `bin/faultline.js` uses `--import tsx` which requires tsx to be resolvable. After `npm install -g @nxtg/faultline`, tsx should be available. Needs manual verification. | Broken global install | S |
| **Repository URL**: package.json points to `awaliuddin/Faultline.git` (the old Kaggle repo). Must update to `nxtg-ai/faultline-pro`. | Incorrect GitHub link on npmjs.com | S |
| **README is stale**: References "829 tests" (actual: 868), links to Kaggle demo/video, says "Built for the Gemini 3 Kaggle competition." The npm README IS the landing page — it must lead with the AI Claim Forensics positioning, not Kaggle origin. | First impression is "a Kaggle project" instead of "a professional tool" | M |
| **No `--help` flag**: Running `faultline --help` returns "Unknown command: --help". Should show usage. | Standard CLI convention broken | S |
| **License**: CC-BY-4.0 is non-standard for npm packages. Enterprise legal teams expect MIT, Apache-2.0, or ISC. CC-BY was designed for creative works, not software. Consider switching to Apache-2.0 (allows commercial use, patent grant, attribution required). | Enterprise adoption friction | S (Asif decision) |

### Important (should fix before or shortly after launch)

| Gap | Impact | Effort |
|-----|--------|--------|
| **No inline scan (stdin/string argument)**: Must provide a file. `faultline scan "GPT-4 is 92% accurate"` (direct string input) would be the fastest hello-world but is not supported. Current minimum is creating a file first. | Extra friction in the 10-second demo | S |
| **React/Vite dependencies in production**: `package.json` includes `react`, `react-dom`, `lucide-react`, `vite` in the npm package. The CLI does not use React. These bloat the install and confuse users. Should be separated (monorepo or separate packages for web UI vs CLI). | `npm install` pulls 50MB+ of React for a CLI tool | M |
| **No CHANGELOG.md**: npm packages benefit from a changelog. Developers check this before upgrading. | Minor trust signal missing | S |
| **No `--version` flag**: `faultline version` works but `faultline --version` does not. Both are expected. | Minor CLI convention | S |
| **Sample text is EU AI Act focused**: `examples/sample.txt` is perfect for the compliance angle but should be supplemented with a medical claim example and a financial claim example to show breadth. | Narrow first impression | S |
| **Error messages could be friendlier**: Missing API key error is clear, but could suggest `--provider mock` for testing. | Minor DX improvement | S |
| **No programmatic API documented**: The package exports nothing for use as a library. `import { scan } from '@nxtg/faultline'` would enable embedding in other tools. CLI-only limits integration. | Limits ecosystem adoption | M |

### Nice to Have (post-launch)

| Gap | Impact | Effort |
|-----|--------|--------|
| Red teaming depth: 40+ attack types in Promptfoo vs templates in Faultline | Competitive gap in red-team use case | L |
| Streaming output for long scans | Better UX for large documents | M |
| `--json` flag shorthand (like `--sarif`) | Minor DX convenience | S |
| Publish VS Code extension to marketplace | Distribution channel | M |
| Docker image for CI environments | Enterprise CI/CD convenience | S |

---

## 6. Metrics to Track

### Primary (check weekly)

| Metric | Tool | Target (30 days) | Target (90 days) |
|--------|------|-------------------|-------------------|
| npm weekly downloads | npmjs.com package page | 100 | 500 |
| GitHub stars | github.com/nxtg-ai/faultline-pro | 50 | 200 |
| GitHub issues from external users | `gh search issues` (exclude @awaliuddin) | 5 | 20 |

### Secondary (check monthly)

| Metric | Tool | Target (90 days) |
|--------|------|-------------------|
| HN front page appearance | hn.algolia.com | 1+ |
| Reddit post engagement (upvotes + comments) | Reddit | 50+ combined |
| Blog post views (comparison + EU AI Act) | dev.to / analytics | 1,000+ combined |
| Forks | GitHub | 10+ |
| Contributors (non-team) | GitHub | 2+ |

### Signals to Watch

- **"How is this different from Promptfoo?"** — If this question dominates, the positioning is not landing. Sharpen the "claims vs prompts" distinction.
- **"Does this work with [provider X]?"** — Track which providers are requested. Prioritize accordingly.
- **"Can I use this in CI?"** — Point to GitHub Action (N-10). If it is not discoverable enough, improve README placement.
- **"EU AI Act compliance — is this legally valid?"** — Expected question. Prepare a disclaimer: "Faultline is a developer tool for risk assessment, not legal advice. Consult qualified legal counsel for compliance determinations."

---

## 7. Competitive Positioning Summary

```
                    PROMPTS              CLAIMS
                    (input testing)      (output forensics)
                    ─────────────        ─────────────────
  Promptfoo    ──── ████████████         ░░░░░░░░░░░
  DeepEval     ──── ███████              ░░░░░░░░░░░
  Faultline    ──── ███                  ████████████

                    RAG METRICS          EU AI ACT
                    ─────────────        ─────────────────
  Promptfoo    ──── ███                  ░░░░░░░░░░░
  DeepEval     ──── ████████████         ░░░░░░░░░░░
  Faultline    ──── ██                   ████████████
```

Faultline does not compete in prompt testing or RAG evaluation. It owns the "claim forensics + compliance" quadrant. This is the positioning to defend.

---

## 8. Pre-Launch Checklist

Before Asif gives the GO for npm publish:

- [x] Fix repository URL in package.json (`nxtg-ai/faultline-pro`)
- [x] Validate `npm pack` + `npx @nxtg/faultline scan` end-to-end
- [x] Rewrite README.md for npm (lead with positioning, not Kaggle origin)
- [x] Add `--help` flag support
- [ ] Remove React dependencies from CLI package (or split packages)
- [x] Confirm license choice with Asif (CC-BY-4.0 vs Apache-2.0) — Apache-2.0 chosen
- [x] Add 2-3 more example files (medical claims, financial claims)
- [ ] Record terminal demo GIF
- [ ] Draft HN and Reddit posts (have them ready, not improvised)
- [ ] Prepare EU AI Act disclaimer for README

---

*This plan was drafted by the Faultline-Pro project team in response to DIRECTIVE-NXTG-20260305-04. The npm publish decision remains with Asif.*
