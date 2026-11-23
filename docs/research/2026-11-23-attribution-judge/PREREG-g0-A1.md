# Amendment A1 to `PREREG-g0.md` (2026-11-23)

Filed before any run of arms M or X. Two events changed the plan.

1. **Arm H ran into a production outage.** It ran on the production key from 01:21Z. At about 01:25Z the production Google project reached its monthly spend cap, and every Gemini call, customer scans included, was refused until the cap was raised at 01:32Z. H was stopped at 01:28Z with 28 rows, the last 5 of them provider errors. H is reported as **stopped, not scored**.
2. **Measurement now has its own Google project.** Faultline Measurement (`gen-lang-client-0212165467`) has its own key and a 50 USD monthly spend cap, so a measurement run cannot use production's cap or rate limits. Running H again would spend production's project, so it is dropped.

## What changes

- **Arms:** M and X only, both on local APIs using the measurement project's key.
- **Re-measure:** arm M replaces H as the re-measure of the production engine. M runs `origin/main` 6b2f410; the deployed engine is 88c4350. They differ only in `CHANGELOG.md`, `README.md` and `examples/ci-integration.yml` (`git diff --stat 88c4350 6b2f410`). M uses production's settings: judge `gemini-3.1-pro-preview`, Parallel `advanced`. It is reported as "the production engine's code and settings, measured on a separate key". It is not the hosted service itself.
- **Arm X:** the head of the PR that carries only the judge attribution rule, `supportBasis`, the input fingerprint and `engineCommit`. The extraction subject rule is not in X. G0 does not run extraction, so this changes nothing G0 measures; X's commit is recorded in every row.
- **Everything else stands:** the sample, scoring, validity rule (190 of 193), the harm rule (FAIL below -0.02, or a CI entirely below 0), the zero-search check for X, the pacing (`--batch-size 5 --pause-ms 30000`) and the cost guard of 4 USD per arm, inside the 50 USD measurement cap.
- **Stop rule added:** if the measurement project's spend reaches 45 USD, or any production scan fails during a run, the run stops.
