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

See "Evidence 2026-10-02" below: `GET /usage` counts before and after a redeploy.
