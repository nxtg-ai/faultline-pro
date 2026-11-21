# Healthcare evidence verification: exploratory scope and decision gates

> **Status: PROPOSAL ONLY. Unapproved; no publication or release decision.**
>
> This note captures the scope and limits of three **separate draft pull requests**. It is not a product commitment, healthcare compliance attestation, medical or coverage advice, or approval to merge or deploy anything.
>
> Last reviewed: 2026-11-17 (America/Chicago). Recheck the linked PRs before using this note for a decision.

## What is being explored

Faultline already checks atomic factual claims extracted from AI-generated text against evidence. The experiment adds three complementary capabilities:

1. **Source restriction:** an optional policy for Parallel Search that limits which domains may supply evidence.
2. **Regulatory citation identity:** an optional lookup of recognized CFR sections and CMS NCD/LCD identifiers against official records.
3. **Saved-scan review record:** an offline report of what a scan did and did not check, with optional CSV-based human labeling.

**Proposed narrow use case:** help a reviewer inspect whether an AI-written, public-source healthcare statement cites a real, current federal regulation or CMS coverage document, and capture the evidence and unresolved questions.

**Not the proposed use case:** decide whether a specific patient's treatment is covered, adjudicate insurance claims, approve/deny reimbursement, determine medical necessity, or certify regulatory compliance.

## Why scope matters: a valid citation is not a coverage decision

Healthcare coverage depends on the question and applicable authority. Relevant context may include:

| Context | Why it can change the answer |
| --- | --- |
| Program | Original Medicare, Medicare Advantage, state Medicaid, and commercial coverage differ. |
| Jurisdiction | State Medicaid rules vary; Medicare local coverage determinations are linked to Medicare Administrative Contractor (MAC) jurisdictions, not simply a universal national rule. |
| Plan and funding | Plan benefits, exclusions, contracts, and the fully insured versus self-funded framework can matter. |
| Date/version | Coverage documents and regulations change; a current record may not establish what applied to an earlier service date. |
| Service and person | Benefit category, eligibility, diagnosis, setting, coding, authorization, network, and medical-necessity criteria may be necessary to answer an individual coverage question. |
| Evidence hierarchy | A federal rule, NCD, LCD, plan document, clinical policy, and individual case record answer different questions and are not interchangeable. |

The tool must preserve these distinct propositions:

- **Citation found:** a referenced identifier exists in a specified record/version.
- **Source applicable:** that authority governs this program, geography/jurisdiction, period, and question.
- **Statement supported:** the actual proposition is supported by the applicable evidence.
- **Individual coverage established:** a member-specific determination has been made using all required context.

The first proposition does **not** establish the next three. Missing context or evidence requires an explicit **unverified / not assessed** outcome rather than a confident coverage answer.

## Illustrative reviewer journey (target workflow, not a shipped end-to-end feature)

1. **Input:** a synthetic or de-identified AI-generated policy explanation containing claims and citations. No patient identifiers, member records, or protected health information in examples or fixtures.
2. **Citation check (draft #148):** detect supported citation patterns (e.g., `42 CFR 422.101(c)`, `NCD 220.6.17`, `LCD L33797`); attempt an official current-record lookup. Record identifier existence separately from the meaning or applicability of a rule.
3. **Evidence retrieval (draft #147):** when opted into Parallel grounding and a source policy, restrict searched/retrieved pages to allowed domains. If the configured policy cannot be applied or yields no eligible evidence, preserve an unchecked result; do not silently search unrestricted sources.
4. **Substantive claim check (existing Faultline):** compare what the AI said with available evidence. Do not represent a citation-existence check as a verified policy interpretation or a member-level determination.
5. **Review artifact (draft #146):** render the saved scan with sources, verdicts, provenance when recorded, and the separate count/list of unsupported, contradicted, mixed, and unchecked items. A human reviewer may supply labels; report their agreement and the limitations of any error-rate estimate.

This flow is conceptual. **The three branches have not been accepted or independently certified as one integrated system.** A scan report can show only information retained by its underlying scan.

### Example of a legitimate finding

A draft letter cites a CFR section or CMS determination that is absent from the current official record. Faultline may flag a **potentially invalid current citation for review**, provided the assertion is actually about a current citation and the lookup is complete and reliable.

It must not automatically infer that the letter's broader clinical, contractual, or individual coverage conclusion is false. A historical, retired, negated, ambiguous, or incorrectly scoped citation needs different handling.

## Experimental branches (all draft; nothing approved)

| Draft | Current proposal | Important boundaries |
| --- | --- | --- |
| [#147: healthcare source policy](https://github.com/nxtg-ai/faultline-pro/pull/147) | Opt-in Parallel Search domain allowlist; per-key policy on hosted API; explicit not-applied/no-match outcomes. | Not a universal healthcare authority graph. Google/OpenAI search is not filtered by this policy. No live paid Parallel contract test or restricted-domain accuracy result is established by the PR's tests. |
| [#148: regulation citation checker](https://github.com/nxtg-ai/faultline-pro/pull/148) | Opt-in current-record lookups for recognizable CFR/NCD/LCD identifiers; guards for historical/negated claims; LCD license acceptance separately opt-in. | Not a historical-law engine, plan resolver, NCD/LCD-content interpreter, or healthcare adjudicator. Fixture tests are not real-world accuracy evidence. |
| [#146: AI output audit report](https://github.com/nxtg-ai/faultline-pro/pull/146) | Offline Markdown/HTML/PDF record from a saved scan; reviewer CSV, agreement and error-rate summary. | Not an independent re-verification, signed attestation, or clinical accuracy measurement. Reviewer sampling and provenance integrity still require evaluation. |

PR heads reviewed for this draft: #146 `810d641c`, #147 `a424937d`, #148 `6ea0e5ed`. The PR descriptions and code may continue changing. These are separate changes targeting `main`; merging one must not be presumed to validate the others.

## Open questions for design review

1. **Applicability:** should the product stop at current federal citation identity, or is any plan-specific policy comparison in scope? If the latter, what are the required plan, jurisdiction, service-date, and document-version inputs?
2. **Semantics:** how do APIs and reports distinguish `citation_exists`, `source_applies`, `claim_supported`, `unchecked`, and `coverage_determined` without conflating them?
3. **Authority:** what source domains, state agencies, MAC jurisdictions, plan documents, and document precedence rules are needed for each narrowly defined test case?
4. **Temporal validity:** how do retired/modified provisions, date-of-service questions, incomplete responses, and ambiguous paragraph parsers avoid false `contradicted` verdicts?
5. **Evidence integrity:** can a reviewer trace each finding to the actual source passage, retrieval timestamp, rule/model version, and unmodified original scan? Can edited CSV fields alter a purported engine result?
6. **Permissions and licensing:** are CMS LCD/CPT-related terms, API usage, customer evidence retention, and privacy/security requirements understood before enabling relevant integrations?
7. **Performance:** what are paid retrieval costs, latency, cache behavior, coverage rate, and the effect of source restrictions on the fraction of claims left unchecked?
8. **Product fit:** is a narrow citation-integrity feature useful to the existing self-serve audience? Do not assume healthcare payers are a validated customer segment.

## Required evidence before a merge or publication decision

- [ ] One explicitly approved **scope statement** and prohibited-claims list, including the distinction between factual verification and insurance-claim adjudication.
- [ ] End-to-end integration tests across #146, #147, and #148, including conflict resolution and correct provenance/reason codes.
- [ ] A labelled, synthetic or lawfully de-identified evaluation set with valid, false, historical, negated, ambiguous, and jurisdiction-mismatched examples. Measure false-contradiction rate, abstention, and coverage, not only test pass counts.
- [ ] Real provider/API contract checks and documented non-success behavior; do not equate fixtures with live provider validation.
- [ ] Review of LCD-related license acceptance and applicable security/privacy requirements before enabling those calls for users.
- [ ] Report wording that separates citation identity from substantive correctness, preserves missing context, and does not present unverified claims as assurance.
- [ ] Independent engineering/domain review and an explicit owner decision to **approve, narrow, continue experimenting, or discard**. No automatic merge, release, customer promise, or marketing claim.

## Source references

- [CMS: Medicare coverage of items and services](https://www.cms.gov/cms-guide-medical-technology-companies-and-other-interested-parties/coverage/medicare-coverage-items-and-services) (NCDs, LCDs, and case-specific review).
- [CMS: Local Coverage Determination process](https://www.cms.gov/cms-guide-medical-technology-companies-and-other-interested-parties/coverage/local-coverage-determination-process-and-timeline) (MAC jurisdiction and effective dates).
- [Medicaid.gov: Benefits](https://www.medicaid.gov/medicaid/benefits) (state administration and benefit variation).
- Draft implementation PRs [#146](https://github.com/nxtg-ai/faultline-pro/pull/146), [#147](https://github.com/nxtg-ai/faultline-pro/pull/147), [#148](https://github.com/nxtg-ai/faultline-pro/pull/148).

**Disposition: undecided.** This document exists to make the experiment reviewable and disposable, not to justify continuing it.
