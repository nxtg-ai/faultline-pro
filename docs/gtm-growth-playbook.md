# Faultline Pro — GTM Growth-Hack Playbook

**Version**: 2.0 (post-first-revenue) | **Date**: 2026-05-31
**Author**: FP team, synthesized from Wolf 5-agent workflow (wf_da70ab92-865, 301k tokens)
**Trigger**: First revenue $19 Personal tier green (2026-05-30) + 1,369 organic npm installs

---

## Companion Artifacts (LEVERAGE — do not rebuild)

| Doc | Content |
|---|---|
| `~/ASIF/enrichment/2026-05-31-faultline-growth-hack-playbook.md` | Wolf's source synthesis (5 Opus agents) — canonical GTM machine |
| `nxtg-content-engine/data/outputs/launch-playbook/2026-03-20_faultline-launch-playbook.md` | CE's 773-line day-by-day launch content calendar (commit `011ab71`) — do NOT rebuild; coordinate with CE for content |
| `~/ASIF/enrichment/2026-04-20-faultline-revenue-playbook.md` | Helena/Marcus persona copy, landing page specs |
| `~/ASIF/enrichment/2026-03-30-faultline-pro-market-intelligence.md` | TAM ($2.47B), acquisition wave, CISO budgets |
| `docs/GTM-PLAN.md` | Original v0.1.0 GTM plan (March 2026, pre-revenue era) |

---

## The Hook

> **The only scanner that maps every AI claim to its EU AI Act risk tier — and hands you the audit evidence.**

Classify + evidence. Never claim "makes you compliant."

---

## Positioning (KEY REFRAME — 2026-05-31)

**Sell "pass your customers' AI-governance questionnaire" — NOT "the deadline."**

The Digital Omnibus tracks a 16-24 month enforcement deferral. Date-pinned urgency is category-eroding with enterprise legal teams. The questionnaire angle is evergreen and closes deals TODAY:

> *Faultline is how AI builders pass their customers' security/AI-governance questionnaires. Free CLI classifies your AI system's risk tier, generates audit-ready evidence mapped to NIST AI RMF + ISO 42001 + EU AI Act. We unblock a SALE.*

**Secondary angle (independence)**: Promptfoo was acquired by OpenAI. Galileo by Alphabet. Faultline is the only AI verification tool not owned by an AI company.

---

## ICP Segments (Ranked by Ladder Speed)

### 1. Deal-Blocked AI Builder (FASTEST — target NOW)
- **Who**: AI eng / technical co-founder / Head of Eng, seed–Series B selling to enterprise
- **Pain**: Customer vendor-security + AI-governance questionnaire is blocking a signed contract
- **WTP**: Expenses $19 on a personal card TODAY to close a deal — zero approval needed
- **Discovery**: npm, HN, r/MachineLearning, r/SaaS, Latent Space, MLOps Discord
- **Conversion path**: CLI scan → critical claims → $19 report prompt → Questionnaire Response Pack

### 2. Marcus the Builder (Top-of-Funnel Feeder)
- **Who**: Indie hacker, startup CTO, OSS maintainer, AI-app dev
- **Pain**: CI/CD baseline. 20% hallucination rate. Wants GitHub Action + SARIF.
- **WTP**: Mostly free; some upgrade when hitting scan limits or team needs
- **Discovery**: HN (60-70% of traffic), Reddit, Show HN, GitHub topics
- **Conversion path**: npm install → watch mode → Pro $49 batch/team features

### 3. Deployer / Integrator (Medium Velocity)
- **Who**: Consultancy, SI, agency shipping AI for clients
- **Pain**: EU AI Act Chapter V pushes accountability to deployers; needs per-client reports
- **WTP**: Per-client billing model; relationship-led
- **Discovery**: LinkedIn, partner networks, conference circuit

### 4. Helena the Compliance Officer (ENDPOINT — slowest, highest value)
- **Who**: GRC / AI-governance officer, Head of Model Risk, DPO at regulated org (finance, health, gov)
- **Pain**: Art. 9/12/14 evidence for board audit; €15M/3% penalty exposure
- **WTP**: $50K/yr Enterprise; 30-90 day procurement cycle
- **Discovery**: LinkedIn, IAPP, GRC communities
- **Conversion path**: Landing page → scoping call (Cal.com) → compliance binder demo → MSA

---

## Top 5 Moves (Next 72h)

1. **CLI point-of-pain nudge** (S, zero CAC): when `faultline scan` returns criticals, print `→ Close your enterprise deal: $19 audit-ready Questionnaire Response Pack at faultline.nxtg.ai/pricing`. Converts the warm 1,369-install pool immediately.

2. **"EU AI Act Readiness Scan" landing page**: free scan → blurred audit preview → $19 unlock. SEO target: "EU AI Act risk tier classification". Reframe: unblock your customer's questionnaire, not the EU deadline.

3. **Reframe the paid report** as "Vendor AI-Governance Questionnaire Response Pack" (NIST AI RMF + ISO 42001 + EU AI Act risk tiers). Same artifact, new anchoring for deal-blocked buyers.

4. **Draft (NOT send)** HN Show HN + 3 Reddit founder-story posts. Run the 46-item HN survivability rubric. Flag: AGED-account requirement for Asif. All content → `@asif` consent queue before dispatch.

5. **Badge feature + 4 buyer-finding adapters**: `faultline scan` emits MD/SVG "EU AI Act: Limited Risk — Faultline-verified" badge linking to report URL (viral loop). Wire adapters: GitHub orgs shipping AI, job-board AI-governance postings, regulated EU verticals, HN/Reddit EU AI Act threads.

---

## Growth Loops

### Loop 1: CLI Nudge (warm → paid, zero CAC)
`faultline scan` with criticals → prints `$19 Questionnaire Response Pack` deep link → converts 1,369 warm installs at zero acquisition cost.

### Loop 2: Badge Loop (viral, compound)
Every adopter README / Hugging Face model card embeds Faultline-verified badge = backlink + social proof + install funnel. Compounds the ~16/day organic baseline.

### Loop 3: Free scan → shareable report URL
Free scan → "share my risk score" (one click → X/LinkedIn) → paywall at the audit PDF where $19 WTP is proven. Drives discovery from sharers' networks.

### Loop 4: Lead-Magnet Loop (email capture)
Free "AI Vendor Questionnaire Readiness" scan gates the paid pack → captures segment-1/4 emails into self-serve beta pool → email nurture for enterprise upgrade.

---

## Channel Strategy

| Channel | Angle | Cadence | Owner |
|---|---|---|---|
| **CLI stdout nudge** (1,369 warm installs) | Point-of-pain: criticals → $19 deep link | Ship once, always-on | FP team |
| **Badge feature** | scan → badge → report URL, viral loop | Ship (real M effort) | FP team + FW |
| **HN Show HN** | "free CLI that classifies your AI system's EU AI Act risk tier" | One launch, Tue-Thu 8-10am ET — GATED on Asif aged account | FP drafts → Asif sends |
| **Reddit** (r/MachineLearning, r/SaaS, r/devops) | Founder story: "tool that got us through customer's AI-security questionnaire" | 1-2/wk, value-first — GATED | FP drafts → Asif sends |
| **faultline-web landing + SEO** | "EU AI Act readiness scan" — free scan → blurred preview → $19 | Always-on | FW team |
| **LinkedIn / IAPP** (Helena, slow lane) | Case studies; "free 60-sec repo scan tells your risk tier" | Drafts queued; parallel nurture | FP drafts → Asif approves |
| **npm README / GitHub topics** | Independence framing; questionnaire-unblock angle | One-time update + ongoing | FP team |
| **CE content calendar** | Day-by-day launch content (773 lines, commit `011ab71`) | Coordinate with CE; do NOT rebuild | CE team |

---

## Buyer-Finding Workflow

### Architectural no-send invariant
`icp_generate_outreach` has **no transport layer** — this is not a policy, it's architecture. Every draft routes to `governance/asif-decisions.md` `@asif` queue + `agenda.json`. Per-item approve/edit/reject. **FP never sends as Asif.**

### Signal Sources (4 adapters)
1. **GitHub adapter**: orgs shipping AI (`topic:llm`, `topic:genai`, `*.ai` domains, eval repos) → maintainers = deal-blocked AI builders
2. **Job-board adapter**: "AI governance/compliance/risk" postings = funded compliance need, active buyers
3. **Regulated-vertical adapter**: EU fintech/health/HR AI teams (GDPR-trained, compliance-budget exists)
4. **Thread adapter**: HN/Reddit EU AI Act threads + live EU AI Act RSS feed (already in Dx3)

### Workflow Steps
1. **Signal → `icp_create`**: feed adapter signals to Dx3 ICP store (confirm `DX3_ENV` + two-DB target)
2. **Pre-score** (deterministic): +EU domain, +ships AI product, +regulated vertical, +compliance job posting; cap drafts ≤10/day
3. **`icp_enrichment`** nightly LLM scorer (existing Dx3 job) enriches to ≥0.7 confidence
4. **`icp_generate_outreach`**: runs on profiles ≥0.7, channel=email, questionnaire/risk-tier hook, returns subject+body only → `@asif` queue
5. **Asif reviews + sends**: each item individually approved; GDPR-compliant (company+role only, no PII)

**Note for FP pane**: Dx3 ICP/GTM MCP tools (`icp_search`, `icp_create`, `gtm_create`) are not exposed to the FP pane. Wolf/Dx3 lane ingests this playbook into Dx3 via `gtm_create` during next enrichment cycle.

---

## Draft Outreach Batch #1 (QUEUED — NOT SENT — @asif consent required)

### Template A — Deal-Blocked AI Builder (segment 1)
**Target**: Devs who reference Promptfoo (GitHub issues/dependents) or post about AI eval alternatives  
**Channel**: GitHub issue reply or public dev.to comment (NOT cold DM)

```
Hey [NAME], saw your question about AI eval alternatives after the Promptfoo acquisition.

I built Faultline — same category, different approach. It classifies your AI outputs 
by EU AI Act risk tier and generates the audit-ready evidence pack that unblocks your 
customer's security questionnaire. One command:

  npx @nxtg/faultline scan --provider mock --input your-file.txt

Not owned by OpenAI or any model vendor. Apache-2.0.
— Asif, NXTG.ai
```

### Template B — Helena (Cold LinkedIn, Compliance Officer)
**Target**: GRC / AI-governance leads at regulated EU companies (250+ employees)  
**Channel**: LinkedIn connection + note

```
Hi [NAME],

Seeing compliance teams at [SECTOR] companies blocked on their customers' AI-governance 
vendor questionnaires right now.

Faultline runs a free repo scan, classifies your AI system's risk tier (NIST AI RMF + 
ISO 42001 + EU AI Act), and generates the evidence pack that answers those questionnaires.

One thing that may matter to your procurement team: we're not owned by OpenAI, Google, 
or any model vendor — conformity assessments need to be independent.

20 minutes to walk through a live scan?
— Asif Waliuddin, NXTG.ai
```

### Template C — Cleo (CISO, Multi-Model Stack)
**Target**: CISOs at companies with public multi-model AI signals  
**Channel**: LinkedIn or conference follow-up

```
Hi [NAME],

After [CONFERENCE/THREAD], you raised the point about vendor-captive AI auditing.

Faultline is FM-agnostic (Gemini, Claude, OpenAI, Perplexity, Ollama), Apache-2.0, 
not owned by any foundation model vendor. Produces SARIF for your CI pipeline + 
audit-ready evidence mapped to NIST AI RMF + ISO 42001 + EU AI Act risk tiers.

[COMPANY]'s multi-model stack means you can't use OpenAI to check OpenAI's work.

15 minutes for a live scan?
— Asif, NXTG.ai
```

---

## 30-Day Execution Calendar

**Week 1 (Jun 1–7) — Conversion infrastructure**
- [ ] CLI nudge: add point-of-pain $19 prompt to `faultline scan` critical output
- [ ] Draft HN Show HN + 3 Reddit posts → `@asif` queue
- [ ] npm README: independence framing + questionnaire angle in hero
- *Metric: nudge live; ≥3 posts queued; baseline conversions tracked*

**Week 2 (Jun 8–14) — Growth loops + buyer-finding**
- [ ] Badge feature: scan → MD/SVG badge → report URL
- [ ] Wire 4 buyer-finding adapters → pre-score → `@asif` queue (≤10/day)
- [ ] Asif reviews + dispatches batch #1 outreach (if approved)
- *Metric: ≥20 badge installs; ≥30 scored profiles queued*

**Week 3 (Jun 15–21) — Community launch**
- [ ] HN Show HN (Asif's aged account, gated)
- [ ] 2 value-first Reddit posts (gated)
- [ ] dev.to: "Faultline vs Promptfoo post-acquisition" + "Passing customer AI questionnaires"
- *Metric: ≥150 npm downloads spike day; ≥5 paid Questionnaire Response Packs*

**Week 4 (Jun 22–28) — Enterprise pipeline**
- [ ] Product Hunt launch (headline battle-tested from HN)
- [ ] LinkedIn/IAPP Helena-lane nurture drafts queued for Asif
- [ ] Gate higher-priced Report SKU (team/multi-system)
- *Metric: ≥10 paying customers; ≥100 lead-magnet emails captured*

---

## Revenue Model (Current State)

| Tier | Price | Buyer | CTA |
|---|---|---|---|
| Questionnaire Response Pack | **$19** one-time or /mo | Segment 1 (deal-blocked builder) | `faultline.nxtg.ai/pricing` |
| Pro | **$49/mo** | Marcus (power user) | `faultline.nxtg.ai/pricing` |
| Enterprise | **$50K/yr** | Helena (regulated org) | Cal.com scoping call |

Priority: Segment 1 (fastest conversion) funds the marketing machine. Helena closes ARR. One Helena close ≈ 220 months of single Personal revenue.
