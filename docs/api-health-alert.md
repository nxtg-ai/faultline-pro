# Hosted API health alert

GoPMO 1.18.7.3.2: alerting fires on a hosted-API failure. Built 2026-10-02 on NXTG-AI.

`scripts/api-health-check.mjs` checks `https://faultline-api.fly.dev/health` every five minutes from cron and sends a Telegram through `~/ASIF/scripts/notify-telegram.sh` when the API goes down and again when it comes back. It follows the same pattern as the grounding allowance alert (`docs/grounding-allowance-alert.md`).

## What it checks

`GET <url>` (default `https://faultline-api.fly.dev/health`, override `FAULTLINE_HEALTH_URL`) with a 10 s timeout. A run makes up to 3 attempts (1 plus 2 retries), 20 s apart, and stops at the first success. The API is **down** only when every attempt fails. An attempt fails on any of:

- timeout (10 s, `AbortSignal.timeout`), logged as `code=timeout`,
- network error (DNS, refused, TLS), logged as `code=error`,
- any HTTP status other than 200,
- a 200 whose body is not JSON, or whose `status` is not `"ok"`.

`/health` needs no key, so the script reads no key and no `.env` file. It prints no secrets.

Exit codes: 0 healthy, 1 down. A worst-case run (three timeouts) takes about 70 s, well inside the five-minute cadence.

## Cadence

Every five minutes, from the NXTG-AI user crontab:

```
*/5 * * * * /home/axw/.cache/faultline-pro/api-health-cron.sh >> /home/axw/.cache/faultline-pro/api-health.log 2>&1  # Faultline-Pro hosted API health alert (1.18.7.3.2)
```

Each run appends one line to `~/.cache/faultline-pro/api-health.log`:

```
<ISO time> UP|DOWN url=<url> code=<http code|timeout|error> latency_ms=<n> attempts=<n> [reason="..."] notified=<true|false>
```

When a Telegram is sent, the notifier's own stdout (`Telegram: sent`) is printed on the line before it.

## Dedup and recovery

State lives in `~/.cache/faultline-pro/api-health-state.json` (override `FAULTLINE_HEALTH_STATE_FILE`): `{status: "up"|"down", since, alertedAt, lastReason}`. A missing or unreadable file counts as up.

| Previous state | This run | Telegram |
|---|---|---|
| up | down | one `Faultline hosted API DOWN: ...` alert; state becomes down |
| down, alerted | down | none (one alert per incident) |
| down, alert failed to send | down | the DOWN alert is retried |
| down | up | one `Faultline hosted API RECOVERED: ...` message with version, latency and roughly how long it was down; state becomes up |
| up | up | none |

If the recovery message fails to send, the state stays down so the next healthy run retries it.

`FAULTLINE_HEALTH_ALERT_PREFIX=TEST` puts `TEST ` in front of every message, for drills. `FAULTLINE_HEALTH_NOTIFY` overrides the notifier path.

## Install

The wrapper is `/home/axw/.cache/faultline-pro/api-health-cron.sh`. It runs Node 22 (`/home/axw/.nvm/versions/node/v22.21.1/bin/node`) on `/home/axw/.cache/faultline-pro/api-health-check.mjs`.

**For now that file is a copy of this branch's `scripts/api-health-check.mjs`** (branch `api-health-alert`, not yet merged). After the branch merges to `main`, switch the wrapper to the `grounding-check-cron.sh` shape: `git fetch -q origin`, then `git show origin/main:scripts/api-health-check.mjs > "$OUT"` (with the conda-safe `env -u LD_LIBRARY_PATH PATH=/usr/bin:/bin /usr/bin/git`), so cron always runs the merged version.

## How to test

Unit tests, no network and no Telegram (fetch, notify, sleep and the state file are injected):

```bash
cd packages/api && npx vitest run tests/api-health-check.test.ts
```

`packages/api/tests/api-health-check.test.ts`, 13 tests: healthy (AH-01), non-200 with retries (AH-02), timeout and network error (AH-03, AH-03b), abort signal passed (AH-03c), bad body status and non-JSON body (AH-04, AH-04b), success on a retry (AH-05), dedup over three failing runs (AH-06), failed send retried (AH-06b), recovery message then silence (AH-07), TEST prefix (AH-08), missing state file (AH-09).

The tests were shown to fail when the code is broken (2026-10-02, each mutation reverted afterwards):

| Mutation in `scripts/api-health-check.mjs` | Result |
|---|---|
| failure branch never alerts (`if (prev.status !== 'down' \|\| !prev.alertedAt)` to `if (false)`) | 9 failed, 4 passed |
| body check removed (`if (body?.status !== 'ok')` to `if (false)`) | 1 failed (AH-04) |
| dedup removed (same condition to `if (true)`) | 1 failed (AH-06) |

Live drill, without touching the real state file:

```bash
FAULTLINE_HEALTH_URL=https://faultline-api.fly.dev/health-does-not-exist-test \
FAULTLINE_HEALTH_STATE_FILE=/tmp/api-health-test-state.json \
FAULTLINE_HEALTH_ALERT_PREFIX=TEST \
  /home/axw/.nvm/versions/node/v22.21.1/bin/node /home/axw/.cache/faultline-pro/api-health-check.mjs
```

The path returns 404, so after three attempts (about 40 s) a `TEST Faultline hosted API DOWN` Telegram is sent and the script exits 1. Delete the temp state file afterwards, or a second drill run is deduped.

## Evidence 2026-10-02

**Fired test alert.** Started 2026-10-02T20:02:05Z, temp state file in the session scratchpad, prefix `TEST`. Exact stdout:

```
Telegram: sent
2026-10-02T20:02:45.839Z DOWN url=https://faultline-api.fly.dev/health-does-not-exist-test code=404 latency_ms=61 attempts=3 reason="HTTP 404" notified=true
exit=1
```

The temp state file afterwards held `{"status": "down", "since": "2026-10-02T20:02:45.839Z", "alertedAt": "2026-10-02T20:02:45.839Z", "lastReason": "HTTP 404"}`. The message text was not captured from Telegram. By the code it reads: `TEST Faultline hosted API DOWN: https://faultline-api.fly.dev/health-does-not-exist-test failed 3 of 3 attempts. Last: HTTP 404 (code 404, 61 ms) at 2026-10-02T20:02:45.839Z.`

**Healthy run.** Started 2026-10-02T20:02:50Z through the installed wrapper `/home/axw/.cache/faultline-pro/api-health-cron.sh`, real state file. Exact stdout:

```
2026-10-02T20:02:50.459Z UP url=https://faultline-api.fly.dev/health code=200 latency_ms=102 attempts=1 notified=false
exit=0
```

This seeded `~/.cache/faultline-pro/api-health-state.json` with `{"status": "up", "since": "2026-10-02T20:02:50.459Z"}`.

**Crontab.** Installed with `crontab -l > file`, append, `crontab file`. 60 lines before, 61 after, and the first 60 lines are byte-identical to before (`cmp`).
