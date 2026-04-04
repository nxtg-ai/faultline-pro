# EU AI Act Compliance Coverage

Reference document for `packages/cli/cli/compliance-report.ts` — `buildEuComplianceReport()`.

Last updated: 2026-04-04 (N-210). Sprint N-204–N-209 closed all enforcement-deadline articles
automatically derivable from a text scan. N-210 raised `compliance-report.ts` Gate 6 mutation
score from 50.44% → 80.81% (292 hardening tests; threshold 80% enforced).

---

## Coverage Status

| Article | Title | Covered? | Evidence Source | Status Logic |
|---------|-------|----------|-----------------|--------------|
| **Art. 5** | Prohibited Practices | ✅ | `complianceReport.claimMappings` — `unacceptable` tier | `non-compliant` if any unacceptable-tier claim detected; else absent |
| **Art. 6** | Classification Rules for High-Risk AI | ✅ | `complianceReport.claimMappings` — `high`/`unacceptable` risk level | `partial` if any high-risk domain claims; `not-applicable` otherwise |
| **Art. 9** | Risk Management | ✅ | `verifications` — contradicted/mixed verdicts; PII/bias rule findings | `non-compliant` for contradicted; `partial` for mixed/unverified/PII; `compliant` otherwise |
| **Art. 10** | Data and Data Governance | ✅ | `ruleFindings` — bias/PII rules; `verifications` — contradicted facts | `non-compliant` for bias findings; `partial` for contradicted/PII; `compliant` otherwise |
| **Art. 11** | Technical Documentation | ✅ | `verifications` — explanation length + source citations | `compliant` if ≥1 claim has explanation or sources; absent if none |
| **Art. 12** | Record-Keeping / Logging | ✅ | `claims` — presence of structured claims with metadata | `compliant` if claims exist; absent if no claims |
| **Art. 13** | Transparency & Information to Users | ✅ | `verifications` — supported/contradicted/mixed split | `compliant`/`partial`/`gap` based on verdict distribution |
| **Art. 14** | Human Oversight | ✅ | `claims` — interpretation-type claims | `partial` if interpretation claims detected; `compliant` otherwise |
| **Art. 15** | Accuracy, Robustness, Cybersecurity | ✅ | Contradiction rate (>30% → accuracy concern); `ruleFindings` injection/shell rules | `partial` if accuracy or security signals; `compliant` otherwise |
| **Art. 50** | GPAI Transparency (users/deployers) | ✅ | `claims` — opinion-type claims (GPAI-generated content signal) | `partial` if opinion claims; `not-applicable` otherwise |
| **Art. 52** | Transparency for Specific AI System Types | ✅ | `ruleFindings` emotion/synthetic rules; `claimMappings` biometric patterns; `claims` opinion | `partial` if any chatbot/emotion/biometric/synthetic signal; `not-applicable` otherwise |
| **Art. 53** | Obligations for Providers of GPAI Models | ✅ | `scan.provider` (identifies GPAI in use) | `partial` if real GPAI provider (not mock); `not-applicable` for mock/none |

---

## Deliberately Excluded Articles

These articles are **not** automatically derivable from a text scan — they require organizational
data, external registries, or human attestation:

| Article | Reason excluded |
|---------|----------------|
| Art. 7 | Updates to high-risk list — static regulatory list, not scannable |
| Art. 8 | General compliance of high-risk AI — covered by Arts. 9/13/14/15 |
| Art. 16 | Provider obligations (CE marking, registration) — organizational process |
| Art. 17 | Quality management system — organizational process, not in scan output |
| Art. 21 | Corrective actions — incident-response process |
| Art. 25 | Value chain responsibilities — multi-party, not determinable from scan |
| Art. 26 | Deployer obligations — overlaps with Arts. 9/13/14; deployer-specific |
| Art. 43 | Conformity assessment procedure — covered implicitly by Annex III checklist |
| Art. 49 | Registration in EU database — referenced in Art. 6 remediations; requires external registry |
| Art. 55 | GPAI systemic risk obligations — requires external systemic-risk designation; FP cannot determine |

---

## Evidence Status State Machine

```
not-applicable  →  No relevant signals in this scan
partial         →  Relevant signals detected but compliance not fully verifiable
compliant       →  Positive evidence of compliance (supported facts, source citations, etc.)
non-compliant   →  Active compliance failure (bias finding, prohibited practice, etc.)
gap             →  Article applies but evidence is insufficient to assess
```

`not-applicable` articles are excluded from `summary.compliantArticles` / `nonCompliantArticles` /
`partialArticles` / `gapArticles` counts but ARE included in `totalArticles` (= `articleEvidence.length`).

---

## testCategoryMappings Cross-Reference

`buildTestCategoryMappings()` maps scan output categories → EU articles for the compliance report
cross-reference table:

| Scan category | EU Article | Status |
|---------------|-----------|--------|
| `fact (supported)` | Art. 13 – Transparency | `compliant` |
| `fact (contradicted)` | Art. 9 – Risk Management | `non-compliant` |
| `fact (unverified/mixed)` | Art. 13 – Transparency | `partial` |
| `opinion` | Art. 50 – GPAI Transparency | `partial` |
| `interpretation` | Art. 14 – Human Oversight | `partial` |
| bias finding(s) | Art. 10 – Data Governance | `non-compliant` |
| high-importance unverified | Art. 10 – Data Governance | `partial` |
| documented claim(s) | Art. 11 – Technical Documentation | `compliant` |
| claim(s) with structured metadata | Art. 12 – Record-Keeping | `compliant` |
| high-risk domain claim(s) | Art. 6 – Classification Rules | `partial` |

---

## Annex III Checklist

Triggered when `annexApplicable === true` (overallRisk is high/critical, OR Art. 6 is partial/non-compliant).
8 items:

| ID | Article | Check |
|----|---------|-------|
| `annex-iii-0` | Art. 6 | High-risk classification trigger detected |
| `annex-iii-1` | Art. 9 | Risk management system evidence |
| `annex-iii-2` | Art. 10 | Data governance evidence |
| `annex-iii-3` | Art. 11 | Technical documentation evidence |
| `annex-iii-4` | Art. 12 | Record-keeping evidence |
| `annex-iii-5` | Art. 13 | Transparency evidence |
| `annex-iii-6` | Art. 14 | Human oversight evidence |
| `annex-iii-7` | Art. 15 | Accuracy/robustness evidence |

---

## Adding a New Article

Pattern used consistently across N-204–N-209:

```typescript
// 1. Compute signals from scan data
const mySignal = scan.something.filter(x => condition(x));

// 2. Build findings array
const myFindings: string[] = [];
if (mySignal.length > 0) {
  myFindings.push(`${mySignal.length} signal(s) detected — describe implication.`);
}

// 3. Determine status
const myStatus: EvidenceStatus = mySignal.length > 0 ? 'partial' : 'not-applicable';

// 4. Push articleEvidence
articleEvidence.push({
  article: 'Article N – Full Title',
  requirement: 'What the article requires.',
  status: myStatus,
  findings: myFindings,
  remediations: getRemediations('Article N', myStatus, myFindings),
  owaspRef: 'OWASP Agentic AI AXX: Relevant category',
  evidenceCount: mySignal.length,
  sourceCount: 0,
  strengthScore: mySignal.length > 0 ? 0.4 : 0,
});

// 5. Add getRemediations() branch
} else if (article.includes('Article N')) {
  rems.push('Specific remediation action per article requirement.');
}

// 6. Add 3 tests: always-present, not-applicable case, partial case
```
