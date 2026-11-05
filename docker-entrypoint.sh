#!/bin/sh
# Runs as root only long enough to hand the ledger directory to the app user,
# then drops privileges. A Fly volume mounted at /var/log/faultline arrives
# owned by root, which hides the chown the image did at build time
# (docs/ledger-volume.md).
set -e
LEDGER_DIR=/var/log/faultline
mkdir -p "$LEDGER_DIR"
chown faultline:faultline "$LEDGER_DIR"
exec su-exec faultline "$@"
