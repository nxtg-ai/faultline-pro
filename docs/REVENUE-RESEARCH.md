# Faultline Pro — Revenue Model Research

**Date**: 2026-03-05
**Requested by**: Asif Waliuddin ("How are we going to make money off of this?")
**Status**: Research complete. Pending Asif's decision on direction.

---

## 1. Competitor Revenue Models

### Promptfoo ($23.6M raised — Insight Partners + a16z)

- **Model**: Open-core
- **Free tier**: CLI, open-source, all core features for local testing/evaluation/vulnerability scanning
- **Enterprise**: Hosted SaaS and on-prem options. Contact sales (pricing not public).
  - Team RBAC, configurable scan targets, detailed reporting/analytics, remediation suggestions
  - On-prem: dedicated runner behind customer firewall (AWS/Azure/GCP)
- **Adoption**: 100K+ developers, 30+ Fortune 500 customers
- **Key insight**: They give away the CLI to build developer adoption, then sell team/enterprise features to the org

Sources:
- [Promptfoo Pricing](https://www.promptfoo.dev/pricing/)
- [Promptfoo Series A ($18.4M)](https://www.insightpartners.com/ideas/promptfoo-raises-18-4-million-series-a-to-build-definitive-ai-security-stack/)
- [Promptfoo Enterprise](https://www.promptfoo.dev/docs/enterprise/)

### DeepEval / Confident AI (YC-backed)

- **Model**: Open-source framework + freemium SaaS platform
- **Pricing**:
  - Free: $0 — DeepEval testing reports, evals in dev/CI, LLM tracing, 10K traces/month
  - Starter: $19.99/user/month + $20/additional user + $25/project — full testing suite, model/prompt scorecards, custom metrics, 20K traces/month
  - Premium: $79.99/user/month — no-code AI eval workflows, real-time alerting, full API access, 100K traces/month, 3-month retention
  - Team/Enterprise: custom — unlimited projects, custom RBAC, HIPAA/SOC2/SSO, unlimited traces
- **Adoption**: 12K+ GitHub stars, 3M monthly downloads, 2M evals/day
- **Enterprise customers**: BCG, AstraZeneca, AXA, Microsoft
- **Key insight**: Apache-2.0 license (not CC-BY). Usage-based pricing (traces) scales naturally with adoption.

Sources:
- [Confident AI Pricing](https://www.confident-ai.com/pricing)
- [DeepEval GitHub](https://github.com/confident-ai/deepeval)

### Snyk (comparable trajectory for CLI-to-Enterprise)

- **Model**: Open-source security scanner → enterprise SaaS
- **Revenue trajectory**:
  - 2017: First commercial contract, $100K ARR by August
  - 2018: $4M ARR
  - 2019: $19M ARR
  - 2023: ~$250M ARR (25% YoY growth)
- **How**: Free CLI scans → enterprise dashboard, team features, SSO/RBAC, developer integrations
- **Key insight**: Developer-first adoption (integrate into workflow with minimal friction), then upsell organization. Took ~6 years to reach $250M ARR.

Sources:
- [Snyk Revenue & Valuation (Sacra)](https://sacra.com/c/snyk/)
- [Snyk Business Breakdown (Contrary Research)](https://research.contrary.com/report/snyk)

### Enterprise AI Compliance Tools

- **OneTrust, Credo AI, Holistic AI**: $50K–$500K/year for AI governance platforms
- **Enterprise compliance infrastructure**: $8–15M to build internally
- **Key insight**: Compliance has real budget. Enterprise tools are expensive. A $5K–25K/year tool is a wedge.

Sources:
- [EU AI Act Compliance SaaS ($50K+ enterprise tools)](https://medium.com/@cyriaczeh/how-i-built-an-eu-ai-act-compliance-saas-platform-in-72-hours-and-why-enterprise-tools-charging-28730ae3000d)
- [Top AI Compliance Tools 2026](https://www.centraleyes.com/top-ai-compliance-tools/)

---

## 2. Market Size

| Metric | Value | Source |
|--------|-------|--------|
| AI governance spending (2026) | $492M | G2 AI Regulations Report |
| AI governance market (2025) | ~$340M | Industry estimates |
| Projected (2030) | >$1B (28%+ CAGR) | Industry estimates |
| Orgs using AI | 78% | G2 |
| Orgs with AI governance programs | 24% | G2 |
| Projected compliance gap cost (2026) | $10B+ for B2B companies | G2 |
| EU AI Act max penalty | €35M or 7% global revenue | EU AI Act |
| EU AI Act high-risk deadline | August 2026 (5 months away) | EU AI Act |
| Global SaaS market (2026) | ~$315B (20% CAGR) | Industry estimates |

Sources:
- [AI Regulations Stats (G2)](https://learn.g2.com/ai-regulations)
- [EU AI Act High-Risk Deadline](https://ai2.work/blog/eu-ai-act-high-risk-deadline-what-august-2026-means-for-business)

---

## 3. Revenue Path Options

### Option A: Open-Core (highest confidence — proven playbook)

| Tier | Price | Features |
|---|---|---|
| Community (CLI) | Free forever | Everything today: scan, verify, SARIF, mock provider, rules engine, claim graph, weakest-link |
| Pro (hosted API) | $29–49/user/month | Hosted scan API (no API key mgmt), team dashboard, scan history with trend analytics, custom rules UI, email support |
| Enterprise | $500–2,000/month or custom | SSO/SAML, RBAC, on-prem runner, audit-trail exports, compliance report templates for legal, SLA |

**Revenue target**: 50 Pro customers at $39/mo = ~$23K ARR by Month 6.

### Option B: EU AI Act Compliance Reports (unique wedge — nobody else has this)

- Audit-ready compliance reports as a premium feature
- Price: $99–499/report, or unlimited on Pro tier
- Target: CTOs and compliance officers at EU-operating companies
- August 2026 deadline creates natural urgency
- Enterprise compliance tools charge €50K+. Faultline at $5K/year is a no-brainer for mid-market.

### Option C: Usage-Based API (scales with adoption)

| Volume | Price per claim |
|---|---|
| First 100/month | Free |
| 100–10K | $0.05/claim |
| 10K–100K | $0.02/claim |
| Enterprise | Custom |

Pass through LLM costs + margin. Works well for CI/CD — every PR triggers a scan, charges accumulate naturally.

### Option D: Consulting / Professional Services (immediate revenue, doesn't scale)

- EU AI Act compliance audits using Faultline as the tool: $5K–25K per engagement
- CI/CD integration services: configure Faultline in enterprise pipelines
- Bootstrapping revenue, not a long-term model — but validates demand and funds development

---

## 4. Recommended Phased Approach

### Phase 1: Adoption (Now → Month 3) — $0 revenue

- Keep CLI free and open-source. Get npm downloads, GitHub stars, community.
- This is the funnel. Developers try it, show compliance team, org buys Pro.

### Phase 2: First Revenue (Month 3–6) — Target $23K ARR

- Launch Faultline Cloud: hosted API + team dashboard
- Lead with EU AI Act compliance reports (unique, urgent, has budget)
- Pro tier at ~$39/user/month
- Add `faultline scan --api-key FL_xxx` flag as the bridge from CLI to cloud

### Phase 3: Enterprise (Month 6+) — Target $100K+ ARR

- Enterprise tier: SSO, on-prem, audit trails, SLA
- Usage-based API pricing for CI/CD at scale
- Compliance-as-a-Service for mid-market companies ($5K–25K/year)

---

## 5. Prerequisites (what must exist before charging money)

1. **Hosted backend** — the CLI is local-only; need a web service for SaaS
2. **Auth + billing** — Stripe + API key management
3. **Team dashboard** — scan results, trend analytics, compliance report history (React web UI from Kaggle could be repurposed)
4. **License change** — CC-BY-4.0 → Apache-2.0 or MIT (enterprise legal teams won't touch CC-BY for production software)
5. **Persistent storage** — database-backed scan history (not filesystem)
6. **PDF compliance reports** — audit-ready output format for legal/compliance teams

---

## 6. Key Takeaway

The money is in **compliance**. Developer tools are a race to the bottom on pricing. But compliance has budget, urgency (August 2026), and Faultline is the **only tool** that maps AI claims to EU AI Act risk tiers. Open-core CLI for adoption, compliance reports/dashboard for revenue.
