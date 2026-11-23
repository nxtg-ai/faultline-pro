# Amendment A3 to `PREREG-g0.md` (2026-11-23)

Filed before the restart of arm M. A2 dropped `--judge-model` from M and X. The first M run stopped as invalid at 01:44Z after 8 rows: one claim's first attempt failed, its retry read the search from the local cache, so the row's first recorded call was the judge, and the runner's engine-identity check (`PREREG-g0.md` / prereg section 5) stopped the run. The runner allows for a cache-served retry only when `--judge-model` is set.

## What changes

- M and X run with `--judge-model gemini-3.1-pro-preview` again. The production fallback model (`gemini-4-argon`) stays set, so the configuration still matches production (A2). The consequence: if any claim is judged by the fallback model, the arm stops as invalid, and that is reported with the fallback count. The secondary reading on primary-judge rows in A2 is therefore the same as the primary reading.
- The 8 rows of the stopped run are reported as invalid, not scored. The search cache is emptied before the restart, so M makes one search per claim.
- Everything else in A1 and A2 stands.
