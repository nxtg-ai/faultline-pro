# Faultline release stage: classification (2026-10-02)

**Asked by Asif, 2026-10-02:** classify Faultline exactly as it is, by proper SDLC and SemVer practice. Never default to "production ready". Make the label consistent everywhere.
**Recommendation: PUBLIC BETA, version 0.x.** Not GA, and not "production ready". This is fp's assessment against the criteria below; Asif rules.

## Criteria used (primary sources)

- **SemVer 2.0.0** (https://semver.org):
  - "Major version zero (0.y.z) is for initial development. Anything MAY change at any time. The public API SHOULD NOT be considered stable."
  - Pre-release labels such as `1.0.0-alpha` and `1.0.0-beta` are allowed.
  - Release 1.0.0 when the software is used in production, users depend on a stable API, or backward compatibility matters.
- **Vercel release phases** (https://vercel.com/docs/release-phases):
  - **Alpha** "lacks the essential features that are required to be ready for GA".
  - **Beta** "does not yet meet our quality standards for GA", and needs "feedback from external customers to validate that this feature solves a specific pain point".
  - **Public Beta** means "publicly announced", "available to the public without special invitation".
  - Public Beta to **GA** requires: "Fully load tested", "All bugs resolved", "Security analysis completed", "At least 10 customers have been on-boarded".
- **GitHub** (https://github.blog/changelog/2024-10-18-new-terminology-for-github-previews/) renamed Alpha/Beta to Private/Public Preview. In both schemes, preview carries no SLA, and GA is "ready for production use" with SLA and support.

## Faultline against those criteria (checked 2026-10-02)

| Criterion | State | Evidence |
|---|---|---|
| Essential features present (Alpha exit) | **Yes** for the core job: paste text → claims extracted → each checked against the web → risk score, critique, report. Paid plans and limits work | Live at https://faultline.nxtg.ai; paid invoices; plan limits enforced (faultline-web #46, #56) |
| Public, no invitation needed (Public Beta) | **Yes** | Open sign-up; pricing page live |
| Quality validated (Beta exit) | **No.** Verdict accuracy has never been measured on a labelled set; the only labelled check is a 5-claim smoke test | `docs/gemini-model-benchmark-results.md`; brief §Lever 2 |
| All bugs resolved (GA) | **No.** Founder UAT on 2026-10-01 found 2 blocking defects (critique hang, refresh re-scan), fixed the same day. Four Google-terms compliance leads are open | faultline-web #50, #55, #57, #58; `docs/research/2026-10-01-cache-and-jev-brief.md` §Compliance |
| Fully load tested (GA) | **No.** The only benchmark ran against a mock engine in-process | `docs/benchmarks.md` (2026-03-20) |
| Security analysis (GA) | **Partial.** Codex adversarial reviews on the critique fix; GHSA-mxc3-4648-6p7x published for faultline-action. No full assessment | runbook §Security advisories |
| Operational readiness | **Partial.** Spend and grounding ledgers reset on every deploy; web KV was broken for about 4.5 months unnoticed | NEXUS N-230; Q-fp-20261001-01 |
| SLA / uptime / support commitment | **None published.** No SLA, uptime or status page found in faultline-web | grep of `app`, `components`, `lib`, 2026-10-02 |
| ≥10 customers onboarded (Vercel GA bar) | **Not checked.** Customer count not read; production Clerk is not readable from fp's seat | — |
| SemVer | **0.x everywhere.** CLI and API 0.11.0 (tagged `v0.11.0`). Web app `package.json` 0.1.0 with **no tags** | `npm view @nxtg/faultline version`; `git tag` in faultline-web |

## Reading

- **Not Alpha.** The essential features exist, it is public, and people pay for it. "Alpha" understates where it is and tells paying customers less than the truth about its maturity.
- **Not GA.** Accuracy is unmeasured, the GA bars (load test, bugs, security, SLA) are not met, and SemVer says 0.x is initial development.
- **Public Beta fits exactly:**
  - Public and paid, but not yet at a quality bar.
  - Needs real-customer feedback.
  - No SLA.
  - Breaking changes possible (0.x).
- **A conservative alternative is defensible: keep ALPHA**, because the core quality metric (verdict accuracy) has never been measured. If Asif prefers that, the requirement is the same: one label, everywhere.

## Exit criteria to GA and 1.0.0 (proposed; Asif rules)

1. Verdict accuracy measured on a human-labelled set, with a published number (Lever 2 baseline, H2.0).
2. Google-terms leads C1–C4 resolved.
3. Load test against the real engine at a stated peak.
4. Zero open P0/P1 defects; a security review of web and API.
5. Ledgers persist across deploys (Fly volume).
6. A published support commitment and a status page.
7. Then `1.0.0`: CLI, API and web versions aligned; stage label removed.

## Consistency: one label, every surface

Single source of truth: a `releaseStage` value (`beta`) plus the version, each defined once.

| Surface | Today | Change | Owner |
|---|---|---|---|
| nxtg.ai landing card | ALPHA | Match the ruling | nxtg-ai lane |
| faultline.nxtg.ai header and footer | No label, no version | Stage badge in the header; version and changelog link in the footer | fw (CE copy review) |
| Pricing / sign-up / terms | No label | One line saying it is in beta and what that means (no SLA, may change) | fw + CE |
| Web app version | `package.json` 0.1.0, no tags | Tag releases; show the version | fw |
| API `GET /health` | `version` only | Add `"stage": "beta"` | fp |
| CLI `--version`, npm README, llms.txt | No label | Show the stage; README badge | fp |
| CHANGELOGs | No stage | Note the stage at the top | fp + fw |
