# Pre-registration, set 2: unattributed policy text (2026-11-23)

Committed before any run on `set2-policy-text.json`. The first held-out set (`heldout.json`, `PREREG.md`) did not reproduce the defect on the unchanged engine: 54 of 54 runs matched. This set aims at the shape that failed: a company's or a public service's own policy text, with no named speaker, where most sources found are news reports quoting it. The Air Canada case is not in it.

**Disclosure:** this set was written after the fix was built and after one development run of the fix on the Air Canada case. It was not run, on either engine, before this commit.

## Items

10 items in 5 pairs. Each false item restates an answer an AI support or service bot gave, as the press reported it; each true item is its opposite. Expected verdicts are in the file. Four of the five pairs come from one bot and one news report (New York City's MyCity chatbot, The Markup, March 2024), so this set covers few distinct cases. Its result is evidence about this shape, not a rate for the product.

## Procedure

- **Baseline, unchanged engine:** the hosted API (0.12.3), `POST /admin/verify-claims`, provider `gemini`, grounding `parallel`, 3 runs per item, batches paced under 15 judge calls a minute.
- **Fix:** the fix branch on a local API with the production judge (`gemini-3.1-pro-preview`), extraction model and Parallel mode (`advanced`), same route and provider, 3 runs per item, same pacing. Its searches are its own, not the baseline's, so a difference can come from the sources as well as from the judge; the result says so.
- **Item verdict:** the majority of 3 runs; three different statuses is "no majority". "Not supported" is contradicted, mixed, unverified, not checkable, an unchecked claim or no majority.

## Outcomes (stated before any run)

- **D, defect rate on the unchanged engine:** false items whose majority verdict is supported, out of 5. Reported as measured.
- **F1, false items passed by the fix:** target 0 of 5.
- **F2, pairs with both items supported on the fix:** target 0 of 5.
- **F3, over-correction on the fix:** true items not supported. It must not exceed the baseline count by more than 1.
- The 18-item set is re-run on the fix (3 runs per item) as the over-correction guard, scored by `PREREG.md`.

Results are published in `RESULTS.md` whatever they show.
