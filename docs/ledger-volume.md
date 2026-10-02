# Ledger volume (faultline-api on Fly)

GoPMO 1.18.7.3.2, Faultline beta gate criterion (b): ledgers survive a redeploy.

## What it holds

`/var/log/faultline` holds three append-only ledgers:

- `provider-spend.jsonl` (`packages/api/src/store/provider-spend.ts`)
- `grounding-prompts.jsonl` (`packages/api/src/store/grounding-allowance.ts`)
- `scan-cost.jsonl` (`packages/api/src/store/costs.ts`)

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
