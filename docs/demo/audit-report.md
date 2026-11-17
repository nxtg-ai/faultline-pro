# AI output audit

Claim-level record of one Faultline scan. Prepared from the scan file alone.

This scan left claims unchecked after a provider error. An unchecked claim is not a finding that the claim is unsupported.

## Scope

| | |
|---|---|
| Renderer | Faultline 0.12.2 |
| Provider recorded | Google Gemini |
| Risk band recorded by the scan | low |
| Scan timestamp recorded | 2026-06-03T00:02:45.974Z |
| Input characters (Unicode code points) | 200 |
| Input SHA-256 | ae2462744b53e5711c54416715bf37163e25400cf18ac894e2632fee42d7ab6d |
| Claims | 10 |
| Unchecked after a provider error | 7 |
| Unchecked for another reason | 2 |
| Scan file degraded flag | not recorded |

Input text, as stored on the scan:

~~~~
Executive Summary — Enterprise AI Security Posture, 2026

The enterprise threat landscape has shifted decisively toward AI-targeted attacks. According to a 2024 McKinsey report titled "The State of En
~~~~

## Method

This report was rendered from the scan file only. It did not call a model or a search service.

Claims are the scan's claims, in file order. A verification id with no claim is listed after those.

A checked verdict is supported, contradicted, mixed, or unverified. Unverified means the check ran and the scan recorded no support; this report calls that unsupported.

A claim is unchecked when it has no verification record, its status is skipped or loading, the record has apiError, the record has notCheckable, or the explanation begins with "Verify failed" (the engine's wording for a provider error, including files saved before apiError was set). An unchecked claim is not a verdict.

Sources, retrieval time, model and passage hash are copied from the verification. Retrieval time is provenance.retrievedAt when the scan recorded it, otherwise the time a cited page was fetched. The passage hash is the SHA-256 of the page bytes the scan fetched (evidence.contentSha256). A field the scan did not record is written as "not recorded". Nothing in those columns is inferred.

## Counts by verdict

| Verdict | Count |
|---------|------:|
| supported | 0 |
| contradicted | 0 |
| mixed | 0 |
| unsupported (checked, no support recorded) | 1 |
| unchecked (not a verdict) | 9 |
| total claims | 10 |

## Counts by claim type

| Type | Claims | supported | contradicted | mixed | unsupported | unchecked |
|------|-------:|-----------:|-------------:|------:|-------------:|----------:|
| fact | 10 | 0 | 0 | 0 | 1 | 9 |
| opinion | 0 | 0 | 0 | 0 | 0 | 0 |
| interpretation | 0 | 0 | 0 | 0 | 0 | 0 |

## Unsupported and contradicted claims

| Claim | Status | Sources | Retrieved | Model | Passage SHA-256 |
|-------|--------|---------|-----------|-------|-----------------|
| s3 — This aligns with a 2023 Gartner study, "Quantifying Agentic Risk in the Modern SOC," which projected that autonomous-agent attack surfaces would triple by 2025. Recorded explanation: No structural analysis provided. | unsupported | not recorded | not recorded | not recorded | not recorded |

## Mixed claims

None.

## Unchecked claims

These claims were not checked. They are listed apart from unsupported and contradicted claims.

| Claim | Why it was not checked |
|-------|------------------------|
| s1 — Executive Summary — Enterprise AI Security Posture, 2026 The enterprise threat landscape has shifted decisively toward AI-targeted attacks. | Verification temporarily unavailable — the verification provider had a transient error. This claim was not checked; re-run the scan shortly. |
| s2 — According to a 2024 McKinsey report titled "The State of Enterprise AI Security," 73% of Fortune 500 organizations experienced at least one model-targeted intrusion in the prior twelve months. | Verification temporarily unavailable — the verification provider had a transient error. This claim was not checked; re-run the scan shortly. |
| s4 — The regulatory backdrop reinforces the urgency. | Verification temporarily unavailable — the verification provider is rate-limited right now. This claim was not checked; re-run the scan shortly. |
| s5 — The European Union's AI Act entered into force in 2024, establishing the first comprehensive horizontal regulation of artificial intelligence. | Verification temporarily unavailable — the verification provider had a transient error. This claim was not checked; re-run the scan shortly. |
| s6 — In the United States, the NIST AI Risk Management Framework, released in January 2023, provides a voluntary structure that many enterprises have adopted as a de facto baseline. | Verification temporarily unavailable — the verification provider is rate-limited right now. This claim was not checked; re-run the scan shortly. |
| s7 — Industry analysts have quantified the cost. | Verification temporarily unavailable — the verification provider is rate-limited right now. This claim was not checked; re-run the scan shortly. |
| s8 — A Forbes Insights survey from 2025 found that the average breach involving a compromised AI pipeline cost organizations $9.4 million, substantially above the cross-industry mean. | Verification temporarily unavailable — the verification provider had a transient error. This claim was not checked; re-run the scan shortly. |
| s9 — Separately, the Ponemon Institute's "2024 Cost of AI Incidents Report" attributed 41% of these losses to undetected data-poisoning attacks. | No verification record for this claim. This is not a verdict. |
| s10 — We recommend a three-tier mitigation program grounded in continuous model monitoring, supply-chain attestation, and pre-deployment red-teaming. | No verification record for this claim. This is not a verdict. |

## Limitations

Faultline's verdict accuracy was measured on a labelled set. The measurement was not pre-registered. The figure this report quotes for the hosted path is balanced accuracy on the 193 Factcheck-Bench claims, in a 200-claim sample, that have a true or false gold label. The hosted path is Parallel search in advanced mode, then a Gemini judge with no Google search tool. The judge model is gemini-2.5-flash. The engine commit is ba11345.

Balanced accuracy is the mean of recall on true claims and recall on false claims. Supported counts as true and contradicted as false. Mixed, unverified and a failed check count as wrong. The interval is a 2,000-resample bootstrap, seed 20260929, from scripts/accuracy-g0-score.py.

The score file docs/research/data/parallel-fast-2026-11-06.parallel.summary.json records balanced accuracy 0.7546546546546546, 95% CI [0.6778109736738769, 0.8294247419247419]. README.md and the changelog print this as 0.755 [0.678, 0.829]. That three-decimal form rounds the point estimate and the lower bound up, and rounds the upper bound down. This report quotes the score file.

Four readings of the same 200-claim sample are in the repo from 2026-11-05 and 2026-11-06. README.md describes them as 0.755 to 0.802. That range rounds the lowest of the four up and the highest up. The score-file values are in the table. They are not pooled into one interval. Two of the four were local API servers, not the hosted engine.

On 2026-11-06 a fast-mode arm, which is not the production setting, scored 0.7189189189189189, 95% CI [0.6413061865228092, 0.7992254408947487] (docs/research/data/parallel-fast-2026-11-06.parallel-fast.summary.json). The write-up kept advanced mode.

This scan is not that measurement. The interval does not apply to a different provider, a different model, a local key, or to the claims in this file. An unchecked claim has no verdict, so it sits outside the figure. Rule findings stored on the scan are not part of this report. This document does not assess regulatory obligations.

| Reading | Balanced accuracy | 95% CI | Commit | Where | Score file |
|---------|-------------------|--------|--------|-------|------------|
| 2026-11-06 Parallel advanced | 0.7546546546546546 | [0.6778109736738769, 0.8294247419247419] | ba11345 | hosted | docs/research/data/parallel-fast-2026-11-06.parallel.summary.json |
| 2026-11-05 Parallel advanced | 0.8015015015015015 | [0.7292065619572604, 0.8705773562023562] | 155132b | hosted | docs/research/data/grounding-arms-2026-11-05.summary.json |
| 2026-11-05 not-checkable, before | 0.7590090090090089 | [0.6806986920348674, 0.833567789968652] | 0a2adb5 | local | docs/research/data/judge-not-checkable-2026-11-05.before.summary.json |
| 2026-11-05 not-checkable, after | 0.7734984984984985 | [0.6976315351315352, 0.8486166126713577] | 61aa917 | local | docs/research/data/judge-not-checkable-2026-11-05.after.summary.json |
