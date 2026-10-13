#!/usr/bin/env bash
# Daily revenue scoreboard read into the Dx3 ledger (GoPMO 1.18.11.1.7).
#
# Custody (dx3-pm al:6f1ead8882d0a97d): fp holds the read-only Stripe key and runs
# the oracle; dx3's writer turns the oracle's --json into one ledger_entry row and
# reads it back. Both scripts run from pinned git objects, never a working tree:
#   oracle  Faultline-Pro@dcc3bff:scripts/stripe-revenue-evidence.py (sha256 pinned below)
#   writer  dx3@6536eb97f5:scripts/ledger/write_scoreboard_row.py (PR 183, merged)
# The key never leaves this machine: the oracle reads its own key file, and only the
# aggregate scoreboard reaches the writer (the writer drops customers[] in process).
#
# Runs from the user timer fp-scoreboard-read.timer at 22:15 America/Chicago, before
# product-oracle's 22:30 CDT daily read (crontab). Exit code is the writer's:
# 0 row read back equal, 1 mismatch or API failure, 2 refused, 3 oracle failed.
set -u

FP_REPO="${FP_REPO:-$HOME/projects/Faultline-Pro}"
DX3_REPO="${DX3_REPO:-$HOME/projects/dx3}"
ORACLE_COMMIT=dcc3bff
ORACLE_PATH=scripts/stripe-revenue-evidence.py
ORACLE_SHA256=c656e87111db7f5ec9fe2d4f1077f34e3945a5f124dc11138747b73899ce48fe
WRITER_COMMIT=6536eb97f59c17cbb1285318ac6d0a8828c2eb5e
WRITER_PATH=scripts/ledger/write_scoreboard_row.py
ARTIFACT_DIR="${SCOREBOARD_ARTIFACT_DIR:-$HOME/.cache/faultline-pro/scoreboard}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
oracle="$work/stripe-revenue-evidence.py"
writer="$work/write_scoreboard_row.py"

if ! git -C "$FP_REPO" show "$ORACLE_COMMIT:$ORACLE_PATH" > "$oracle"; then
  echo "scoreboard-read: cannot read the oracle at $ORACLE_COMMIT" >&2
  exit 2
fi
if ! git -C "$DX3_REPO" cat-file -e "$WRITER_COMMIT^{commit}" 2>/dev/null; then
  git -C "$DX3_REPO" fetch -q origin "$WRITER_COMMIT" 2>/dev/null || git -C "$DX3_REPO" fetch -q origin
fi
if ! git -C "$DX3_REPO" show "$WRITER_COMMIT:$WRITER_PATH" > "$writer"; then
  echo "scoreboard-read: cannot read the writer at $WRITER_COMMIT" >&2
  exit 2
fi
actual=$(sha256sum "$oracle" | cut -d' ' -f1)
if [ "$actual" != "$ORACLE_SHA256" ]; then
  echo "scoreboard-read: oracle sha256 $actual is not the pin $ORACLE_SHA256" >&2
  exit 2
fi

mkdir -p "$ARTIFACT_DIR"
out=$(python3 -I "$oracle" --json); rc=$?
printf '%s' "$out" | python3 -I "$writer" ingest \
  --oracle-exit "$rc" --oracle-file "$oracle" \
  --oracle-ref "Faultline-Pro@$ORACLE_COMMIT:$ORACLE_PATH" \
  --account acct_1OwvgaKNwotOtIDk --expect-key-sha12 2ebba5c7d201 \
  --pin-sha256 "$ORACLE_SHA256" \
  --lane fp --agent fp --artifact-dir "$ARTIFACT_DIR"
