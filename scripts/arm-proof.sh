#!/bin/bash
# arm-proof.sh <engine cwd> <arm commit> <out file>
# Proves the engine started from <engine cwd> loads the arm's code: require.resolve of
# @nxtg/faultline from that cwd, then every file git tracks in the arm commit's
# packages/cli compared by git hash-object against the resolved package directory,
# plus any untracked, non-ignored file in it. Exit 0 = match, 1 = mismatch.
set -u
CWD="$1"; ARM="$2"; OUT="$3"
G="env -u LD_LIBRARY_PATH PATH=/usr/bin:/bin:$PATH git"
R=$(cd "$CWD" && node -e "console.log(require.resolve('@nxtg/faultline/providers/verdict-reply.ts'))") || { echo "resolve failed" > "$OUT"; exit 1; }
PKG=$(dirname "$(dirname "$R")")
REPO=$($G -C "$PKG" rev-parse --show-toplevel)
REL=${PKG#"$REPO"/}
total=0; bad=0; missing=0
{
  echo "arm-proof $(date -u +%FT%TZ)"; echo "engine cwd: $CWD"; echo "require.resolve: $R"; echo "package dir: $PKG (repo $REPO, path $REL)"; echo "arm commit: $($G -C "$REPO" rev-parse "$ARM")"
  while IFS=$'\t' read -r meta path; do
    want=$(echo "$meta" | awk '{print $3}'); f="$REPO/$path"; total=$((total+1))
    if [ ! -f "$f" ]; then echo "MISSING $path"; missing=$((missing+1)); continue; fi
    have=$($G -C "$REPO" hash-object "$f")
    [ "$have" = "$want" ] || { echo "MISMATCH $path have=${have:0:12} want=${want:0:12}"; bad=$((bad+1)); }
  done < <($G -C "$REPO" ls-tree -r "$ARM" -- "$REL")
  untracked=$($G -C "$REPO" ls-files --others --exclude-standard -- "$REL" | grep -v '/node_modules$' | grep -v '^.*node_modules$' || true)
  nun=$(printf '%s' "$untracked" | grep -c . || true)
  [ -n "$untracked" ] && printf 'UNTRACKED %s\n' $untracked
  echo "files in arm tree: $total, mismatched: $bad, missing: $missing, untracked: $nun"
  if [ "$bad" = 0 ] && [ "$missing" = 0 ] && [ "$nun" = 0 ]; then echo "RESULT: MATCH"; else echo "RESULT: MISMATCH"; fi
} > "$OUT"
grep -q "RESULT: MATCH" "$OUT"
