# AI output audit

`faultline audit-report` turns a scan result JSON into a client record of what that scan checked. It reads the file and writes the report. It does not call a model or a search API.

```bash
faultline audit-report --scan result.json --out report.md
faultline audit-report --scan result.json --out report.html
faultline audit-report --scan result.json --out report.pdf
faultline audit-report --scan result.json --labels-out claims.csv
faultline audit-report --scan result.json --import-labels claims.csv
faultline audit-report --scan result.json --import-labels claims.csv --out agreement.json
```

`--out` and `--labels-out` can be used together. `--import-labels` needs `--scan`, the scan the CSV was exported from, and does not take `--labels-out`. A sample rendered from the synthetic scan `docs/demo/audit-scan.json` is committed as `docs/demo/audit-report.md`, `docs/demo/audit-report.html` and `docs/demo/audit-report.pdf`. The report says it is synthetic example data. It is not a client audit. `docs/demo/scan-result.json` is a separate, older file of provider errors and is not that sample.

The compliance renderers (`faultline report`, `faultline compliance-report`) are a different command. This report does not use them, and its header is not a regulatory frame.

## What the report contains

- **Scope.** Provider, risk band and timestamp as the scan file recorded them, the judge model and the engine commit, the input length in Unicode code points, the SHA-256 of the input, and how many claims were unchecked. The judge model is the distinct `provenance.model` values on the verifications. When none are recorded, the report uses `judgeModel` or `provenance.model` or `config.judgeModel` on the scan file. The engine commit is `provenance.commit` or `provenance.engineCommit` on a verification, then `engineCommit` or `commit` on the scan, its `provenance`, or its `config`. A missing value is `unknown`. Nothing else is filled in.
- **Method.** How a claim becomes supported, contradicted, mixed, unsupported or unchecked.
- **Counts** by those five words, and the same counts by claim type (fact, opinion, interpretation).
- **Unsupported and contradicted claims.** One row per claim: the claim text, the explanation the scan stored, sources (title and URL), retrieval time, model, and passage SHA-256. Retrieval time is `provenance.retrievedAt`. When the scan did not store that and did store a page-fetch time, the cell says "page fetched" and the timestamp. The passage hash is `evidence.contentSha256`. A fallback judge is labelled "(fallback model)". Anything the scan did not record stays "not recorded".
- **Mixed claims,** in their own table, with the same provenance columns.
- **Unchecked claims,** listed apart from the findings. A claim is unchecked when it has no verification record, its status is `skipped` or `loading`, the record has `apiError` or `notCheckable`, or the explanation begins with `Verify failed` (the engine's older wording for a provider error, including `docs/demo/scan-result.json`, which was saved before `apiError` was set). The wording is the customer-safe sentence from `sanitizeVerifyError`. The raw provider payload is not copied into the report. A claim with no source inside the configured source policy is labelled `Unchecked: no allowed source found` and is not counted as a provider error. The report treats `apiErrorReason: "source_policy_no_match"`, a provenance flag `sourcePolicyNoMatch`, `sourcePolicyMiss` or `noAllowedSource`, or (when those fields are absent) `apiError: true` whose explanation says no source was on the source-policy allowlist. A provider error without that reason, flag or sentence stays a provider error.
- **Limitations.** The hosted engine's measured balanced accuracy, quoted from the score file rather than from the three-decimal rounding in the README, with the judge model and date it was measured with.

Text from the scan file (claim text, explanations, source titles and URLs, provider, judge model, commit) is untrusted. In the Markdown report each value is one line: `&`, `<` and `>` become character references, so raw HTML stays text, and `\`, `|`, `[`, `]`, `(`, `)`, `*`, `_` and backticks are backslash-escaped, so the text cannot open a link, emphasis, a code span or a new table column. Any web address, `www.` host or email address inside that text (claim text, explanations, model output, source titles, reviewer ids) is put in a code span, and a backslash in that span is escaped before a pipe, so no Markdown viewer makes it clickable and a `\|` cannot open a new table column: the report carries our name over the output it audits. The one exception is a source URL that the scan's own retrieval recorded: an `http` or `https` address is written as a link, `<https://...>`, so the reader can open the evidence. A source URL with any other scheme is shown as text. The input is quoted in a tilde fence longer than any run of tildes in it (at least four), so no line of the input can close the fence; the input itself is quoted unchanged. The HTML report escapes the same values as HTML. A claim saved with no `id` is listed as unchecked under a label such as `missing-id-1`. No verification is matched to it, and the label never equals a real claim id or verification key.

Unsupported means the check ran and the status is `unverified`. A provider failure that left the status `unverified` is unchecked, not unsupported.

## Measured accuracy, as the score files record it

The figure the report quotes for the hosted path (Parallel search, advanced mode, then a Gemini judge with no Google search tool) is balanced accuracy **0.7546546546546546**, 95% CI **[0.6778109736738769, 0.8294247419247419]**, on the 193 binary-labelled claims in a 200-claim Factcheck-Bench sample. Source: `docs/research/data/parallel-fast-2026-11-06.parallel.summary.json`. It was measured on 2026-11-06 with the judge model `gemini-2.5-flash` (the write-up, `docs/research/2026-11-06-parallel-fast-vs-advanced.md`, names the Gemini 2.5 Flash judge; the score file does not record the judge). The production judge model changed on 2026-11-14, to `gemini-3.1-pro-preview`, and this hosted figure has not been re-measured since that change. The report then says: "On the same 193 claims, a pre-registered comparison on 2026-11-14, run on a local API and not the hosted engine, measured gemini-3.1-pro-preview at balanced accuracy 0.7822072072072072, 95% CI [0.7091077288175319, 0.8512971989705367] (docs/research/data/judge-ab-2026-11-14.summary.json). In that run it was not shown better than gemini-2.5-flash: paired difference +0.0309309309309308 [-0.01083119383825415, 0.07636544483803065]. A second pre-registered run that day on the same model is invalid under its pre-registration, because 179 of 193 claims returned a status." The report states both beside the figure. It does not print a commit for that measurement, and it does not put the measurement's model on the scan: the Scope table prints the judge model and engine commit recorded on the scan being reported, or `unknown`. The measurement was not pre-registered. Balanced accuracy is the mean of recall on true claims and recall on false claims. Supported counts as true and contradicted as false. Mixed, unverified and a failed check count as wrong. The interval is 2,000 bootstrap resamples, seed 20260929, from `scripts/accuracy-g0-score.py`.

`README.md` and the changelog print that reading as 0.755 [0.678, 0.829]. The point estimate and the lower bound are higher in that rounding than in the score file, and the upper bound is lower. The report quotes the score file, and it says so.

The same sample has three other readings in the repo. The report lists them at the same precision and does not pool them. Two were local API servers. A fast-mode arm on 2026-11-06, which is not the production setting, scored 0.7189189189189189 [0.6413061865228092, 0.7992254408947487]. The report says the interval does not apply to a different provider, a different model, a local key, or to the claims in the scan being reported. An unchecked claim has no verdict, so it sits outside the figure.

A test reads each score file and fails if a quoted digit string drifts.

## Reviewer CSV

`--labels-out` writes one row per claim. The reviewer fills `reviewer_id` (blank means `reviewer`), `reviewer_label` and `reviewer_notes`. A second reviewer adds another row for the same `claim_id` with their own `reviewer_id`.

Accepted labels, case-insensitive: `supported` (also `verified`, `true`), `contradicted` (also `refuted`, `false`), `mixed`, `unverified` (also `unsupported`). `skip`, `abstain` and `n/a` leave the claim out. Any other word is an unknown label: the claim is left out of the rate and counted under that reason.

Empty provenance cells mean the scan did not record that field.

Cells whose text starts with `=`, `+`, `-`, `@`, a tab or a carriage return are prefixed with one single quote before the file is written, including `faultline export` CSV. A spreadsheet then treats the cell as text. Reading the file back drops that one quote, so the original text is what the importer scores.

## Importer

`--import-labels` scores the filled CSV against the scan given with `--scan`. The scan's verdict for each claim is read from the scan file, the same way the report classifies it. The CSV's `engine_status` and `engine_bucket` columns are never used for scoring; a row whose engine columns differ from the scan is counted and reported, and the scan's verdict is used.

**Error rate.** Among claims the scan checked and a reviewer labelled, the share whose label differs from the scan's verdict. The four words above are compared exactly. `unsupported` from a reviewer matches a scan status of `unverified`. When several reviewers labelled a claim, the label is their majority. A tie is excluded and listed.

Every claim in the scan is scored or excluded for exactly one reason, and the output states each count, with the claim ids where a reviewer can act on them:

- the scan did not check the claim (excluded even if a reviewer labelled it);
- the claim has no row in the CSV;
- conflict: one reviewer (one `claim_id` and `reviewer_id`) gave the claim more than one labelled row. The claim is left out of the error rate and of reviewer agreement. An extra row with a blank label is ignored and counted, so a later blank does not hide an earlier label;
- unknown label: a reviewer label that is not one of the accepted words, even when another reviewer's label is readable;
- no reviewer label (blank, `skip`, `abstain` or `n/a`);
- reviewers tied with no majority.

CSV rows that are not a claim in the scan are not scored and are counted apart: rows with an empty `claim_id`, and rows whose `claim_id` is not in the scan (listed by id).

The output states the number of claims in the scan and the number of data rows in the CSV, and the rate is printed as a fraction over the scored claims and as the quotient. When no claim qualifies, the rate is not computed. It is not reported as zero.

**Confidence interval.** 2,000 resamples of the scored claims, sorted by claim id, seed 20260929, mulberry32, index `floor(u * n)`, 95% interval by linear percentile (the numpy default). This is not the numpy generator used for the published balanced-accuracy interval, and this rate is not balanced accuracy.

**Reviewer agreement.** When the file has two or more reviewers, each pair gets the count of claims both labelled, the exact-match rate, and Cohen's kappa. Kappa is reported as undefined when chance agreement is 1. One reviewer is not an inter-reviewer agreement.

`--out agreement.md` writes the same text the command prints. `--out agreement.json` writes the counts, the interval, the pairs and the confusion matrix (rows are the scan's verdict, columns are the reviewer label).
