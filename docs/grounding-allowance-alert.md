# Gemini grounding allowance alert (N-230)

**Ruling:** Asif, 2026-10-01 (wolf relay al:9331f52f622f3aea): alert when production's Gemini grounded-prompt count passes 80% of the free daily allowance, 1,200 of 1,500. Past 1,500, each grounded prompt costs $0.035 and a default-pipeline scan goes from about $0.01 to about $0.22 (`docs/unit-economics-prod-default-2026-09-30.md`). The alert is the signal to reprice on real usage.

## What is counted

The prod default pipeline is provider `gemini` (`gemini-2.5-flash`), consensus off. Each claim is verified by one `generateContent` call with the `googleSearch` tool (`packages/cli/services/geminiService.ts`, `verifyClaim`; `retrieveSources` is the other grounded call).

- **One count per successful Gemini request that carried `googleSearch`.** Gemini 2.5 grounding is billed per prompt, not per search query: "when you use search grounding with Gemini 2.5 or older models, your project is billed per prompt" (https://ai.google.dev/gemini-api/docs/google-search). A tool-enabled prompt counts even if the model chose not to search, so the count is an upper bound on billed prompts. That errs toward alerting early.
- **Failed calls are not counted.** A 429, 5xx or network error returns no response. No Google source says a failed request draws on the grounding allowance, and the cost harness already treats failed calls as unbilled (v0.11.0). The count undercounts only if Google counts errors, which would show up as overage on the bill.
- **Not counted:** extraction and `verifyClaimGrounded` (no tool), and OpenAI `web_search` legs (a different provider and bill).

## The day

Google: "Requests per day (RPD) quotas reset at midnight Pacific time", and "Rate limits are applied per project, not per API key" (https://ai.google.dev/gemini-api/docs/rate-limits, read 2026-10-01). The pricing page states the grounding allowance in the same unit: Gemini 2.5 Flash paid tier, "1,500 RPD (free, limit shared with Flash-Lite RPD), then $35 / 1,000 grounded prompts" (https://ai.google.dev/gemini-api/docs/pricing). Neither page states the grounding allowance's reset clock separately, so applying the RPD clock to it is an inference from the shared unit. The allowance-day is the `America/Los_Angeles` calendar date (DST-aware), and the server reports `resetsAt`.

## Where it is counted

`packages/api/src/store/grounding-allowance.ts`. The engine's usage sink (`packages/cli/lib/usage-sink.ts`) now has a process-wide observer, `subscribeUsage`. The API subscribes once at `buildServer()`. An observer is used instead of the per-route capture scopes because only `/scan`, `/scan/stream` and `/critique` capture usage. Batch, bulk, deep, schedules and the scan queue call the engine uncaptured, and their prompts draw on the same allowance.

Each grounded prompt appends one row to an append-only ledger (`/var/log/faultline/grounding-prompts.jsonl`, override `FAULTLINE_GROUNDING_LEDGER`): `{ts, day, provider, model, callType}`, no key and no text. The day count is hydrated from the ledger once per day per process, the same pattern as `provider-spend.ts`.

## GET /usage (admin key only)

```json
"groundingAllowance": {
  "day": "2026-10-01",
  "clock": "America/Los_Angeles",
  "resetsAt": "2026-10-02T07:00:00.000Z",
  "groundedPrompts": 0,
  "freeDailyLimit": 1500,
  "alertThreshold": 1200,
  "overThreshold": false,
  "overFreeLimit": false,
  "processStartedAt": "…",
  "ledgerWriteFailures": 0
}
```

`overThreshold` is true at `groundedPrompts >= 1200`. `providerBudget` now also carries `ledgerWriteFailures`.

## Durability, honestly

The ledger survives a process restart on the same machine. It does **not** survive a redeploy or machine replacement: `/var/log/faultline` is the Fly machine's filesystem, not a volume (`packages/api/fly.toml` has no `[mounts]`). The provider-spend ledger has the same gap (`docs/provider-spend-cap.md`, Known limitations).

A second gap was found while building this: the image runs as the non-root `faultline` user and never created `/var/log/faultline`, so the ledgers most likely could not be written at all and lived only in memory. This was a strong inference; fp had no `fly ssh` access to check. The Dockerfile now creates the directory and gives it to `faultline`, and `ledgerWriteFailures` on `/usage` is the check (0 after a real scan means the file is being written).

Two mitigations are in place:

1. `processStartedAt` on `/usage` shows when the count restarted.
2. The alert script carries the last count it saw forward when the server restarts mid-day and its count drops. It can still miss prompts sent between its last hourly check and the restart.

The real fix is a Fly volume: about 1 GB, `[mounts]` in `fly.toml`, and both ledger paths pointed at it. fp has no `fly auth` on NXTG-AI, so this needs Asif or a lane with Fly access.

**Tier: paid (confirmed by Asif 2026-10-01, "paid tier bro").** The production Gemini project is on the paid tier, so 1,500 grounded prompts a day are free, then $0.035 each, and the 1,200 alert threshold is correct. Not checked: whether other Gemini traffic shares the same Google project and its daily allowance.

## The alert

`scripts/grounding-allowance-check.mjs`, run hourly from cron on NXTG-AI (the same pattern as fw's KV spend monitor):

```
7 * * * * /home/axw/.cache/faultline-pro/grounding-check-cron.sh >> /home/axw/.cache/faultline-pro/grounding-check.log 2>&1
```

The wrapper pulls the script from `origin/main` and runs it with Node. Each run:

- reads `GET https://faultline-api.fly.dev/usage` with `FAULTLINE_API_KEY` (env, else `/home/axw/projects/faultline-web/.env.local`; never printed),
- appends one row to `~/ASIF/governance/spend-monitor/faultline-pro-grounding.jsonl`,
- sends `~/ASIF/scripts/notify-telegram.sh` once per allowance-day per level: at the threshold, and again past the free 1,500. The dedupe key is `day:level:threshold`, kept in `~/.cache/faultline-pro/grounding-alert-state.json`,
- exits 0 OK, 1 ALERT, 2 probe failure. A probe failure (HTTP error, missing field, no key) also sends a Telegram, at most once a day while it lasts.

`GROUNDING_ALERT_THRESHOLD=<n>` overrides the threshold on the client side only. It is used for the scheduler drill and does not change the server.

## Tests

`packages/api/tests/grounding-allowance.test.ts` (19) and `packages/cli/tests/usage-sink.test.ts` US-05/US-06. The end-to-end tests mock the SDK at the module boundary, count the `googleSearch` requests the mock receives, and assert the server's count equals that number. They cover an uncaptured engine scan and a real `POST /scan`.
