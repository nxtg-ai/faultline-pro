# AI output audit

Claim-level record of one Faultline scan. Prepared from the scan file alone.

Synthetic example data. This report was rendered from an example scan, not from a client document.

## Scope

| | |
|---|---|
| Renderer | Faultline 0.12.2 |
| Provider recorded | Example |
| Judge model recorded | example-judge |
| Engine commit recorded | unknown |
| Risk band recorded by the scan | medium |
| Scan timestamp recorded | 2026-11-17T15:00:00.000Z |
| Input characters (Unicode code points) | 189 |
| Input SHA-256 | 3f51ef1a784a4a9b73661ee6ac74e3fdaafd30e4b05a1633d3d11ef212ebfc9d |
| Claims | 5 |
| Unchecked after a provider error | 0 |
| Unchecked: no allowed source found | 1 |
| Unchecked for another reason | 0 |
| Scan file degraded flag | false |

Input text, as stored on the scan:

~~~~
Northwind Clinic outpatient note, March 2024. Synthetic example, not a patient record.

The clinic billed 12 outpatient visits. The plan paid $400 for each visit. The clinic is in Portland.
~~~~

## Method

This report was rendered from the scan file only. It did not call a model or a search service.

Claims are the scan's claims, in file order. A verification id with no claim is listed after those.

A checked verdict is supported, contradicted, mixed, or unverified. Unverified means the check ran and the scan recorded no support; this report calls that unsupported.

A claim is unchecked when it has no verification record, its status is skipped or loading, the record has apiError, the record has notCheckable, or the explanation begins with "Verify failed" (the engine's wording for a provider error, including files saved before apiError was set). An unchecked claim is not a verdict. A claim left unchecked because no source was inside the configured source policy is labelled "Unchecked: no allowed source found". That is not a provider error. The scan may record it as apiErrorReason "source_policy_no_match", as a provenance flag, or, when neither field is present, as apiError with an explanation that says no source was on the source-policy allowlist.

Sources, retrieval time, model and passage hash are copied from the verification. Retrieval time is provenance.retrievedAt when the scan recorded it, otherwise the time a cited page was fetched. The passage hash is the SHA-256 of the page bytes the scan fetched (evidence.contentSha256). A field the scan did not record is written as "not recorded". Nothing in those columns is inferred.

## Counts by verdict

| Verdict | Count |
|---------|------:|
| supported | 1 |
| contradicted | 1 |
| mixed | 1 |
| unsupported (checked, no support recorded) | 1 |
| unchecked (not a verdict) | 1 |
| total claims | 5 |

## Counts by claim type

| Type | Claims | supported | contradicted | mixed | unsupported | unchecked |
|------|-------:|-----------:|-------------:|------:|-------------:|----------:|
| fact | 4 | 1 | 1 | 0 | 1 | 1 |
| opinion | 0 | 0 | 0 | 0 | 0 | 0 |
| interpretation | 1 | 0 | 0 | 1 | 0 | 0 |

## Unsupported and contradicted claims

| Claim | Status | Sources | Retrieved | Model | Passage SHA-256 |
|-------|--------|---------|-----------|-------|-----------------|
| n2 — The plan paid $400 for each of those visits. Recorded explanation: The example payment file shows $125 per visit, not $400. | contradicted | Example payment file \(https://example.test/northwind/payments\) | 2026-11-17T12:00:02.000Z | example-judge | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |
| n3 — The clinic is in Portland. Recorded explanation: No example source states the city. | unsupported | not recorded | 2026-11-17T12:00:03.500Z | example-judge | not recorded |

## Mixed claims

| Claim | Sources | Retrieved | Model | Passage SHA-256 |
|-------|---------|-----------|-------|-----------------|
| n4 — Volume rose while the payment per visit fell. Recorded explanation: Visit counts rose in the example ledger. The payment per visit did not fall. | Example visit ledger \(https://example.test/northwind/visits\) | 2026-11-17T12:00:00.000Z | example-judge | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |

## Unchecked claims

These claims were not checked. They are listed apart from unsupported and contradicted claims.

| Claim | Why it was not checked |
|-------|------------------------|
| n5 — The 2024 physician fee schedule lists this code at $90. | Unchecked: no allowed source found |

## Limitations

Faultline's verdict accuracy was measured on a labelled set. The measurement was not pre-registered. The figure this report quotes for the hosted path is balanced accuracy on the 193 Factcheck-Bench claims, in a 200-claim sample, that have a true or false gold label. The hosted path in that measurement was Parallel search in advanced mode, then a Gemini judge with no Google search tool. The measurement's judge model and date are stated with the figure below. They describe that measurement, not this scan. The judge model recorded on this scan is example-judge. The engine commit recorded on this scan is unknown. A value the scan file did not record is unknown.

Balanced accuracy is the mean of recall on true claims and recall on false claims. Supported counts as true and contradicted as false. Mixed, unverified and a failed check count as wrong. The interval is a 2,000-resample bootstrap, seed 20260929, from scripts/accuracy-g0-score.py.

The score file docs/research/data/parallel-fast-2026-11-06.parallel.summary.json records balanced accuracy 0.7546546546546546, 95% CI [0.6778109736738769, 0.8294247419247419]. It was measured on 2026-11-06 with the judge model gemini-2.5-flash (docs/research/2026-11-06-parallel-fast-vs-advanced.md). The production judge model changed on 2026-11-14, to gemini-3.1-pro-preview. This hosted figure has not been re-measured since that change. README.md and the changelog print this as 0.755 [0.678, 0.829]. That three-decimal form rounds the point estimate and the lower bound up, and rounds the upper bound down. This report quotes the score file.

Four readings of the same 200-claim sample are in the repo from 2026-11-05 and 2026-11-06. README.md describes them as 0.755 to 0.802. That range rounds the lowest of the four up and the highest up. The score-file values are in the table. They are not pooled into one interval. Two of the four were local API servers, not the hosted engine.

On 2026-11-06 a fast-mode arm, which is not the production setting, scored 0.7189189189189189, 95% CI [0.6413061865228092, 0.7992254408947487] (docs/research/data/parallel-fast-2026-11-06.parallel-fast.summary.json). The write-up kept advanced mode.

This scan is not that measurement. The interval does not apply to a different provider, a different model, a local key, or to the claims in this file. An unchecked claim has no verdict, so it sits outside the figure. Rule findings stored on the scan are not part of this report. This document does not assess regulatory obligations.

| Reading | Balanced accuracy | 95% CI | Where | Score file |
|---------|-------------------|--------|-------|------------|
| 2026-11-06 Parallel advanced | 0.7546546546546546 | [0.6778109736738769, 0.8294247419247419] | hosted | docs/research/data/parallel-fast-2026-11-06.parallel.summary.json |
| 2026-11-05 Parallel advanced | 0.8015015015015015 | [0.7292065619572604, 0.8705773562023562] | hosted | docs/research/data/grounding-arms-2026-11-05.summary.json |
| 2026-11-05 not-checkable, before | 0.7590090090090089 | [0.6806986920348674, 0.833567789968652] | local | docs/research/data/judge-not-checkable-2026-11-05.before.summary.json |
| 2026-11-05 not-checkable, after | 0.7734984984984985 | [0.6976315351315352, 0.8486166126713577] | local | docs/research/data/judge-not-checkable-2026-11-05.after.summary.json |
