# Ledger volume (faultline-api on Fly)

GoPMO 1.18.7.3.2, Faultline beta gate criterion (b): ledgers survive a redeploy.

## What it holds

`/var/log/faultline` holds three append-only ledgers:

- `provider-spend.jsonl` (`packages/api/src/store/provider-spend.ts`)
- `grounding-prompts.jsonl` (`packages/api/src/store/grounding-allowance.ts`)
- `scan-cost.jsonl` (`packages/api/src/store/costs.ts`)

and the API keystore, which is rewritten rather than appended:

- `keystore.json` (`packages/api/src/store/keys.ts`), beside `key-idempotency.jsonl` (the `POST /keys` Idempotency-Key ledger)

### The keystore file

Every API key issued with `POST /keys`, `POST /orgs/:id/keys` or GraphQL `createKey` is kept in `keystore.json`. The environment keys (`FAULTLINE_API_KEY`, the server key, and `FAULTLINE_MEASUREMENT_KEY`) are not in it and do not change.

| | |
|---|---|
| Path | `keystore.json` in the same directory as the Idempotency-Key ledger (`FAULTLINE_KEY_IDEMPOTENCY_LEDGER`, default `/var/log/faultline/key-idempotency.jsonl`), so `/var/log/faultline/keystore.json` in production. `FAULTLINE_KEYSTORE_FILE` names another file. `FAULTLINE_KEYSTORE_FILE=off` keeps the keystore in memory only; the API test suite sets it so parallel test files never share a file |
| Shape | `{ "version": 1, "keys": [ ... ] }`. Each key holds `id`, `keyHash`, `keyPrefix`, `name`, `permissions`, `createdAt`, and when set `previousKeyHash`, `previousKeyExpiresAt`, `lastRotatedAt`, `lastUsedAt`, `expiresAt`, `disabled`, `metered`, `claimCap`, `stripeCustomerId`, `scopes` |
| Secrets | None in the clear. `keyHash` and `previousKeyHash` are SHA-256 hex of the key and, during the 24-hour rotation grace, of the key it replaced. `keyPrefix` is the first 8 characters of the current key, so an operator can tell keys apart; it cannot authenticate. The plaintext is returned once, by the call that creates the key or rotates it, and is not stored anywhere |
| Write | The whole keystore on every change (create, delete, PATCH, disable, enable, rotate, bulk disable, enable and delete, clearing an expired grace hash): a temp file in the same directory with mode 0600, fsync, rename over `keystore.json`, then fsync of the directory. A crash mid-write leaves the previous file whole. A successful authentication only moves `lastUsedAt`; that is written at most once a minute (a timer writes the latest value when the minute ends) |
| Load | Once, when the process starts. No file: no keys. A file that exists but cannot be read or parsed, or holds one record out of shape (a timestamp that does not parse counts as out of shape): no keystore keys (they do not authenticate), the server starts anyway, `loadFailures` counts it, one fixed line is logged, and the file is renamed to `keystore.json.unreadable-<ms>` (copied there if the rename fails) so the next write does not overwrite what may still be recovered. If it can be neither renamed nor copied, every later write is refused and counted until a restart, so the bad file is never replaced |
| Write failure | The change stays in memory and is served, `writeFailures` counts it, and one fixed line is logged. A failed fsync of the directory after the rename counts too, since a crash could then bring back the old file. A restart loses changes made since the last good write |
| Refused fields | The store never writes what it could not load: a create or update with an unknown permission or a timestamp that does not parse is refused and changes nothing (`PATCH /keys/:id` answers 400 `invalid_key_field`, GraphQL `createKey` answers `BAD_USER_INPUT`) |
| Shutdown | Closing the server writes a pending `lastUsedAt` at once; nothing is written after close |
| Counters | Admin `GET /usage` returns `keystore: { keys, persisted, loadFailures, writeFailures, idempotencyWriteFailures }`. Both failure counts are per process and start at 0 |

Not in the file: which org or tenant a key belongs to (the org and tenant stores keep their own records), and the list of deleted metered key ids that background jobs check (those jobs do not survive a restart either).

There was no migration. Before this change keys lived only in memory, so production had none when it shipped, and a key made before the deploy does not exist after it.

### Row shapes

`provider-spend.jsonl`, camelCase: `{ ts, scanId, month, tier, provider, modelId, costUsd, claimCount, verifiedCount }`. Field meanings in `docs/provider-spend-cap.md`.

`scan-cost.jsonl`, snake_case, one row per scan, full-scan step or admin verify batch (critique writes none):

| Field | Meaning |
|---|---|
| `ts`, `scan_id` | When, and the id shared with the provider-spend row for the same call |
| `user_tier`, `key_mode`, `kind` | Plan label, always `managed`, and `scan`, `full-scan` or `admin-verify` |
| `provider`, `model_id` | Provider and the model priced |
| `input_tokens`, `output_tokens`, `tool_call_count` | Usage priced (`tool_call_count` is grounding calls) |
| `usd_estimate`, `wall_ms`, `cache_hit` | Cost in USD, wall time, cache hit |
| `claim_count` | Claims the call handled (extracted, or submitted) |
| `verified_count` | Claims that got a billable verdict: supported, contradicted or mixed, with at least one source, a retriever the engine bound (`provenance.retriever`, which the engine grants only to a built-in provider's own instance), not an API error (`unverified`, zero-source verdicts and verdicts with no engine retriever never count; full rule in `docs/provider-spend-cap.md`) |

Every row this code writes carries both counts as numbers. `claim_count` and `verified_count` are `null` only for an event read back from a row written before the counts existed; the loader reads such rows without them.

The CLI's `faultline export` (JSON and NDJSON) also has a `verified_count` field. It is a different count: the number of verification results the local history entry stores, unverified, unsourced and errored ones included. It is not a count of billable claims.

The spend cap and the grounding allowance count are rebuilt from these files when the process starts, so the files are the authority. Before 2026-10-02 the directory was in the container filesystem, and every deploy started all three at zero.

## How it is set up

| Piece | Where |
|---|---|
| Volume `faultline_ledgers`, 1 GB, `lax`, encrypted, daily snapshots kept 5 days | created by `.github/workflows/fly-ops.yml` action `create-ledger-volume` (run 37058601450, `vol_vz8lw92mj65jymqv`) |
| Mount at `/var/log/faultline` | `packages/api/fly.toml` `[mounts]` |
| Owner fix | `docker-entrypoint.sh`. A Fly volume mounts owned by root, which hides the image's build-time `chown`. The entrypoint starts as root, chowns the directory and runs the app as the `faultline` user through `su-exec` |
| One machine | `fly-ops.yml` action `scale-to-one` (run 37058567316 destroyed `781371df542908`) |

Fly has no `flyctl` login on NXTG-AI. Every Fly change goes through `fly-ops.yml`, which uses the repo secret `FLY_API_TOKEN`. That workflow has fixed actions only.

## Why one machine

A volume belongs to one machine. With two machines, each would write its own copy of each ledger. The $100 spend cap and the grounding count would each see only part of the traffic, so the cap could be passed by up to 2×. Before the change the app had two machines and no volume. `GET /usage` on 2026-10-02 at 20:0xZ showed one process (`processStartedAt` 19:10:58Z) with zero counts, so the split was possible but had not happened.

Trade-offs, accepted while the product is alpha:

- A deploy restarts the only machine, so there are a few seconds of downtime. The 5-minute health alert (`docs/api-health-alert.md`) can fire during a deploy.
- The volume is pinned to one Fly host. If that host fails, the app is down until the machine is moved, and the ledgers are restored from a snapshot (up to a day lost).
- Scaling out later needs a shared store for the ledgers (a database), not more volumes.

## Evidence

### Evidence 2026-10-02

Instrument: admin `GET /usage` (`providerBudget`, `groundingAllowance`), read with the server key. The probe prints counts only, never the key.

| Step | Time (UTC) | `processStartedAt` | `groundedPrompts` | `spentUsd` | `ledgerWriteFailures` |
|---|---|---|---|---|---|
| Before the change: 2 machines, no volume | 20:0x | 19:10:58.439 | 0 | 0 | 0 |
| Deploy with the new entrypoint, no volume (run 37059141375) | 20:14 | 20:13:44.039 | 0 | 0 | 0 |
| Deploy with `[mounts]` (run 37060417958). This first mounted deploy starts from an empty volume, as expected | 20:26 | 20:25:59.697 | 0 | 0 | 0 |
| One real hosted scan, provider gemini, 2 claims | 20:27:00 | 20:25:59.697 | **2** | **0.0710461** | 0 |
| Redeploy, no code change (`fly-deploy.yml` dispatch, run 37060661819) | 20:28:01 | **20:27:34.904** | **2** | **0.0710461** | 0 |

The process changed (20:25:59 to 20:27:34) and the counts did not. Before the volume, the same redeploy would have reset both counts to 0. `fly-ops` inspect (run after the mount) shows `vol_vz8lw92mj65jymqv` `faultline_ledgers` attached to machine `801e00c6973668`, the only machine.

`ledgerWriteFailures` 0 after a real write confirms the entrypoint handed the root-owned mount to the `faultline` user. Locally, the same image on a root-owned docker volume showed the directory owned by `faultline`, `node` running as `faultline`, and `/health` 200.

The 5-minute health alert stayed UP across these deploys (`~/.cache/faultline-pro/api-health.log`, 20:20:02 and 20:25:02 UP). The restarts fell between its checks, so they did not test the alert.
