# Pre-registration: does naming the subject at extraction cure the failing claim? N = 10 per engine (2026-11-23)

Committed before any of these runs. The judge-only rate test (`PREREG-rate.md`) found no clear difference from the judge rule: supported 6 of 10 on local `main`, 4 of 10 on the fix. The diagnostic pointed at extraction: the claim with its subject named came back contradicted 3 of 3. This measures the extraction change on the path it changes.

This is the regression case (the Air Canada files), so the result is about this case, not a rate for the product. The prompts are frozen at the fix commit named below; nothing is changed between or after these runs.

## Inputs

ce's two files, as the CLI scans them (whitespace at the ends removed): `subject.txt` (sha12 of the file 497433afa773) and `control.txt` (37ab72b2e52a).

## Engines

`POST /scan` on two local APIs with the same keys and production settings (judge `gemini-3.1-pro-preview`, extraction `gemini-3.5-flash-lite`, grounding `parallel`, Parallel mode `advanced`), no scan cache (server key):

- **M:** `origin/main` 6b2f410.
- **F:** the fix branch at d1e049b (subject rule at extraction, attribution rule at the judge).

10 scans of each file on each engine, interleaved M, F, about 15 seconds apart. 40 scans in all.

## Outcomes and reading rules (fixed now)

- **Defect run (subject):** any claim that states the 90-day after-travel rule comes back supported.
- **Over-correction run (control):** the claim that states the policy does not apply after travel comes back anything but supported.
- **Subject named:** whether the extracted 90-day claim names Air Canada.
- **Cure:** F is better than M only if F has at least 4 fewer defect runs out of 10. A smaller gap is reported as no clear difference.
- **Harm:** F must not have more than 1 more over-correction run than M.
- Provider errors are counted and reported, never re-run.
