# Pre-registration: the judge grades truth, not attribution (2026-11-23)

Written and committed before any judge change and before any run on the held-out set. The commit that adds this file and `heldout.json` is the pre-registration; later commits may add results, never change these two files.

## The defect

On the hosted engine (0.12.3, judge `gemini-3.1-pro-preview`, Parallel retrieval), a chatbot's known-false answer came back **supported** because the retrieved sources confirm the chatbot gave that answer. The sources also say the answer was wrong. The true opposite statement came back supported in a separate scan the same night. The judge treated "someone stated this text" as evidence that the text is true.

The claim under test did not say "the chatbot said". It was the chatbot's own words. So the rule must cover any claim whose sources only report that a party asserted it, not only claims phrased "X said Y".

## Intended behaviour

1. A source that only reports that a person, company or system stated the claim is not evidence that the claim is true. The claim is judged on whether what it says is true.
2. When the claim is itself about attribution ("X said Y", "the report concludes Y"), it is judged on whether X said Y.
3. A party's own statement about its own facts (an issuer's rate decision, an agency's own publication) still counts as evidence, unless other sources show it is wrong.
4. A claim and its negation should not both come back supported. Separate scans cannot enforce this, so it is measured below, not claimed as a guarantee.

## Sets

- **Regression (not scored here):** the two claims from the Air Canada case. Paragraph 2 of the chatbot answer is expected contradicted; the true policy sentence is expected supported. These may be run during development.
- **Development:** any claims the author writes while working. Not scored.
- **Held-out:** `heldout.json`, 18 items, 3 negation pairs, classes asserted-false, negation-true, attribution-true, attribution-false and own-statement-true. Expected verdicts are in the file. It is not run while the prompt is being changed: once before the change (baseline) and once after the change is deployed and frozen.

## Procedure

- **Instrument:** `POST /admin/verify-claims` on the hosted API, provider `gemini`, the server's default grounding (Parallel). This is the verify step of a scan without extraction and without the evidence page fetch that `/scan` adds.
- **Runs:** each item 3 times in the baseline and 3 times after the fix. Batches paced to stay under 20 judge calls a minute.
- **Item verdict:** the majority of its 3 runs. No majority (three different statuses) is recorded as "no majority".
- **Not supported:** contradicted, mixed, unverified, not checkable, an unchecked claim (provider error), or no majority.
- The judge model and the fallback share are recorded for every run. A run answered by the fallback model is reported, not dropped.

## Outcomes (stated before any run)

- **P1, false claims passed:** items expected contradicted whose majority verdict is supported. Target after the fix: 0.
- **P2, both halves of a pair supported:** pairs whose two items both have majority verdict supported. Target after the fix: 0 of 3.
- **P3, over-correction:** items expected supported whose majority verdict is not supported. After the fix it must not exceed the baseline count by more than 1.
- **Also reported:** exact agreement with the expected verdict, per item and in total, before and after.

The results are published in this folder whether the fix meets the targets or not. If the baseline shows no defect on this set (P1 = 0 and P2 = 0), that is reported as found, and the fix is judged on the regression case and the tests alone.
