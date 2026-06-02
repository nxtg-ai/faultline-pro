# Consulting Citation-Gate — Validate-First Kit

> **Status:** READY TO FIRE (gated on 2 Asif inputs — see §6).
> **Origin:** `~/ASIF/learning/faultine-fuckup/2026-06-01-faultline-real-pain-demand-map.md` (17-agent demand sweep). Winner wedge = **consulting / Big-Four pre-publish citation-verification gate**. This kit makes the demand map's "ONE validate-first test, build nothing" fireable.
> **Discipline:** No new product. Uses the *existing* engine as-is. No overclaim — we do NOT say "ensure compliance," "agent governance," or sell a fictional pack. We say exactly what the engine does: **verify every citation in a report against live web sources before it ships, and flag the ones that don't exist.**

---

## 1. The wedge (one sentence)

A consulting firm is hours from sending a client deliverable full of AI-assisted citations; Faultline runs every citation against live web search and flags the fabricated ones **before** the report leaves the building — the exact failure EY Canada shipped and then had to publicly withdraw.

**The anchor proof — a verified Big-Four PATTERN, not a one-off (public, real, dated, with real money lost):**

| Firm | Client / deal | What was fabricated | Outcome | Source |
|---|---|---|---|---|
| **EY Canada** (May 2026) | 44-page cybersecurity report | 16 of 27 citations hallucinated — broken URLs, nonexistent Forbes/McKinsey/Gartner articles; GPTZero flagged 72% AI | **Report withdrawn** | [goingconcern.com](https://www.goingconcern.com/ey-gets-busted-and-yeets-cybersecurity-report-littered-with-ai-hallucinations/) |
| **Deloitte Canada** (Nov 2025) | Newfoundland & Labrador healthcare report, **~$1.6M**, 526 pages | False citations from made-up papers; real researchers (e.g. Gail Tomblin Murphy, Dalhousie) named on papers they never wrote; a Canadian Journal of Respiratory Therapy cite absent from the database | Citations revised under public scrutiny | [fortune.com](https://fortune.com/2025/11/25/deloitte-caught-fabricated-ai-generated-research-million-dollar-report-canada-government/) |
| **Deloitte Australia** (Jul 2025) | Government report, **$290K** | Fabricated references + quotes from generative AI | **Partial refund** | [businessstandard.com](https://www.business-standard.com/technology/tech-news/deloitte-ai-hallucination-report-australia-gpt4o-fabricated-references-125100800915_1.html) |

Two of the Big Four, three deliverables, government clients, a refund and a public withdrawal — the failure is systemic and it costs real money and reputation. That is the room the buyer lives in.

**Why the engine genuinely fits:** the failure mode *is* the mechanic. A fabricated trade-press article returns nothing from live Google Search; "returns nothing" (`status: unverified`) is the engine's strongest, most demoable verdict. No incumbent owns this step in the consulting publish pipeline (unlike legal, where Westlaw/Lexis reach a corpus we can't).

---

## 2. The offer one-pager (the pitch — honest, no overclaim)

**Headline:** *Don't let your firm be the next withdrawn report.*

**Sub:** Every AI-assisted deliverable gets one final check before it ships — Faultline verifies each citation against live sources and flags the ones that don't exist. Paste the draft, get a per-citation verdict in seconds.

**What it does (exactly, no more):**
- Decomposes the report into atomic claims + citations.
- Verifies each against **live Google Search grounding**.
- Returns per-citation `supported / contradicted / unverified` with the cited source URL (or the absence of one).
- Acts as a **publish gate**: `--fail-on high` blocks a deliverable whose citations don't verify.

**What it does NOT claim:** it is not a compliance certification, not legal cite-checking against proprietary case law, not agent governance. It is a citation/claim verifier for a body of text. (These boundaries are the whole point — they're what the prior positioning got wrong.)

**Form factor:** a pre-publish gate wired into the report-production / QA workflow. The paste box is the demo; the *product* is the gate risk/quality leaders mandate on every AI-assisted deliverable.

---

## 3. The demo recipe (the "gun") — exact commands, existing engine

> Requires a `GEMINI_API_KEY` (Asif input — §6). The engine is the published `@nxtg/faultline` CLI; nothing new is built.

> **⚠️ PRODUCT-TRUTH NOTE (verified live, 2026-06-02, mock-provider smoke test).** The engine's default `--output-format markdown` and `html` renderers **lead with "EU AI Act Risk Tier / Risk Summary"** — the exact compliance veneer the demand map said to kill. Do **not** hand a prospect the raw markdown/html for this demo; it relapses into the dead positioning. The clean citation-gate data lives in `--output-format json` at the top level: `claims[]` + `verifications{ status, sources[] }`. Consume those; ignore the embedded `complianceReport` field. (See §7 — the one thing worth building *if* the test gets a yes is a thin citation-gate view of that JSON.)

### 3a. Public "watch it light up red" demo (no prospect needed)
Use a publicly-documented hallucinated document so the demolition is dramatic and verifiable. Strongest public option: the **White House MAHA report** (7 documented fabricated citations + `oaicite` AI markers — [nbcnews.com](https://www.nbcnews.com/health/health-news/trump-admin-corrects-rfk-jrs-maha-report-citation-errors-rcna209913)).

```bash
export GEMINI_API_KEY=<asif's key>
# 1. Save the report text (or the citations section) to report.txt
# 2. Run the engine as a pre-publish gate (clean JSON, not the compliance-framed md/html):
npx @nxtg/faultline scan \
  --input report.txt \
  --provider gemini \
  --output-format json \
  --fail-on high  > result.json
# Exit code != 0 = "this deliverable would FAIL the gate."
# In result.json: each citation = a claim; verifications[id].status === 'unverified'
# with empty sources[] is a fabricated citation the engine could not ground.
```

### 3b. Prospect demo (the real test)
Take a **real AI-assisted report the prospect hands over** (or one they've already published), run the exact command above on it, and walk them through the `unverified` citations with the live-search evidence (or absence) beside each. The whole pitch is the artifact, not a slide.

### 3c. Polished leave-behind
For the validate-first test, hand-format the `claims[]` + `verifications{}` from `result.json` into a one-page "X of N citations could not be verified" table — fabricated ones in red, with the claim text and the empty/again-searched source. No EU-AI-Act chrome. (If the test gets a yes, §7 is the one formatter worth building.)

---

## 4. Outreach draft — ⚠️ GATED ON ASIF SEND (agent-hands boundary)

> I do **not** send as Asif to third parties. These are drafts; Asif sends (or routes to a warm intro). Per `~/.claude/rules/agent-hands-boundary.md`.

**Target:** a risk / quality / brand-protection leader at a peer professional-services or consulting firm — **NOT** embarrassed EY.

**Cold email (v1):**
> Subject: EY pulled a report; Deloitte refunded one — a 10-min check that catches it
>
> Hi {Name},
>
> In the last year EY Canada withdrew a cybersecurity report after 16 of its 27 citations turned out AI-fabricated, and Deloitte had to revise a $1.6M government healthcare report — and refund an Australian one — for the same reason: real-looking citations to papers and articles that don't exist.
>
> We built the check that catches that before it ships. Run an AI-assisted deliverable through it; every citation gets verified against live sources in seconds, and the fabricated ones get flagged — a pass/fail gate before anything reaches a client.
>
> Can I run it on one of your recent reports and show you exactly what it finds? No charge, 10 minutes. If it surfaces nothing, you've lost 10 minutes; if it surfaces one fabricated citation, you've seen the headline you'll never have.
>
> — {Asif}

**LinkedIn DM (v2, shorter):**
> {Name} — after the EY withdrawn-report story, we built a pre-publish gate that verifies every citation in an AI-assisted deliverable against live sources before it ships. Could I run it on one of your reports and show you what it flags? 10 min, no charge.

---

## 5. Target list (reachable roles — fill named contacts on Asif's network)

| Priority | Role to target | Why reachable |
|---|---|---|
| 1 | Head of Quality / Risk at a mid-tier management consultancy | Owns the publish-gate mandate; EY story is a board-level fear |
| 2 | Brand-protection / comms lead at a professional-services firm | Withdrawn-report = direct brand loss; their job to prevent it |
| 3 | Partner running an AI-enablement / "AI center of excellence" practice | Already mandating AI use → on the hook for AI failures |
| 4 | Founder/principal of a boutique research/analyst shop publishing AI-assisted reports | Smaller, faster yes; no procurement maze |

*(Names + warm intros are Asif's network — I can draft per-contact variants once named.)*

---

## 6. The two Asif inputs that fire this (the only blockers)

1. **`GEMINI_API_KEY`** — drop it in the env (or hand me a scoped key, key-safe) and I produce the real §3a public demolition artifact end-to-end. Without it I will NOT fabricate engine output (that's the one failure this product exists to catch).
2. **Send approval + a named target** (or "use a warm intro") — then the §4 draft goes out. The send stays gated on you per the agent-hands boundary; everything up to the send is done.

**Success criterion (unchanged from the demand map):** a paid commitment for *this* form factor (signed LOI / prepaid pilot / "invoice me X/month for the gate"). Not "interesting." On a no: fold the verifier in as a feature of a broader QA offering, or kill — do **not** iterate the consulting face.

---

## 7. The ONE thing worth building — only IF the test gets a yes

A thin **citation-gate view** of `scan --output-format json`: render `claims[]` + `verifications{status, sources}` as a clean "X of N citations unverified" report — **no `complianceReport`/EU-AI-Act chrome**. ~1 file, consumes the existing engine output, no new verification logic. This is the honest version of the demo leave-behind. **Do not build it before a buyer commits** — the demand map's whole verdict is validate-first-build-nothing, and the hand-formatted §3c table is enough to run the test. Listed here so the build is scoped and ready, not so it's done early.

---
🌽 Generated with NextGen AI - Intelligent Systems
https://nxtg.ai
Co-Authored-By: AxW <axw@nxtg.ai>
