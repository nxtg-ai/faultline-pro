#!/bin/bash
# arm-proof.sh <api package dir> <arm commit> <out file>
#
# Proves that a local API engine started from <api package dir> loads the arm's
# engine code, before a measurement run starts. Exit 0 and "RESULT: MATCH" only
# when all of these hold:
#   - @nxtg/faultline resolves the way the API's own source files resolve it
#     (require.resolve from <api package dir>/src);
#   - git can read the arm commit and its tree of that package is not empty;
#   - every file the arm commit tracks in that package has the same git object
#     hash on disk (git hash-object), none is missing, no file tracked here is
#     absent from the arm, and no untracked, non-ignored file sits in the package;
#   - package-lock.json at the repository root equals the arm commit's.
# Installed dependency files under node_modules are not hashed; the lockfile
# that pins them is. A commit read from git HEAD or FAULTLINE_GIT_SHA cannot
# prove which code ran: a worktree whose node_modules links to another
# checkout loads that checkout's packages (2026-11-23).
set -u
API="${1:?api package dir}"; ARM="${2:?arm commit}"; OUT="${3:?out file}"
G="env -u LD_LIBRARY_PATH PATH=/usr/bin:/bin:$PATH git"
fail() { echo "RESULT: MISMATCH ($1)" >> "$OUT"; exit 1; }
: > "$OUT"
{
  echo "arm-proof $(date -u +%FT%TZ)"
  echo "api package dir: $API"
} >> "$OUT"
[ -d "$API/src" ] || fail "no src directory under $API"
R=$(node -e "console.log(require.resolve('@nxtg/faultline/providers/verdict-reply.ts', { paths: [process.argv[1]] }))" "$API/src" 2>/dev/null) || fail "@nxtg/faultline does not resolve from $API/src"
PKG=$(dirname "$(dirname "$R")")
REPO=$($G -C "$PKG" rev-parse --show-toplevel 2>/dev/null) || fail "resolved package is not in a git repository: $PKG"
REL=${PKG#"$REPO"/}
FULL=$($G -C "$REPO" rev-parse --verify --quiet "$ARM^{commit}") || fail "arm commit not found: $ARM"
{
  echo "require.resolve from $API/src: $R"
  echo "package dir: $PKG (repo $REPO, path $REL)"
  echo "arm commit: $FULL"
} >> "$OUT"
TREE=$($G -C "$REPO" ls-tree -r "$FULL" -- "$REL") || fail "git ls-tree failed"
[ -n "$TREE" ] || fail "the arm commit tracks no files under $REL"
total=0; bad=0; missing=0
while IFS=$'\t' read -r meta path; do
  want=$(echo "$meta" | awk '{print $3}'); f="$REPO/$path"; total=$((total+1))
  if [ ! -f "$f" ]; then echo "MISSING $path" >> "$OUT"; missing=$((missing+1)); continue; fi
  have=$($G -C "$REPO" hash-object "$f") || fail "git hash-object failed on $path"
  [ "$have" = "$want" ] || { echo "MISMATCH $path have=${have:0:12} want=${want:0:12}" >> "$OUT"; bad=$((bad+1)); }
done <<< "$TREE"
# A file tracked here but not in the arm's tree could be imported too.
extra=0
armfiles=$(printf '%s\n' "$TREE" | cut -f2)
tracked=$($G -C "$REPO" ls-files -- "$REL") || fail "git ls-files failed"
while IFS= read -r t; do
  [ -z "$t" ] && continue
  printf '%s\n' "$armfiles" | grep -qxF -- "$t" || { echo "EXTRA $t" >> "$OUT"; extra=$((extra+1)); }
done <<< "$tracked"
untracked=$($G -C "$REPO" ls-files --others --exclude-standard -- "$REL") || fail "git ls-files failed"
nun=0
if [ -n "$untracked" ]; then
  while IFS= read -r u; do echo "UNTRACKED $u" >> "$OUT"; nun=$((nun+1)); done <<< "$untracked"
fi
lock_want=$($G -C "$REPO" rev-parse --verify --quiet "$FULL:package-lock.json") || fail "arm commit has no package-lock.json"
lock_have=$($G -C "$REPO" hash-object "$REPO/package-lock.json" 2>/dev/null) || fail "no package-lock.json in $REPO"
lock_ok=yes; [ "$lock_have" = "$lock_want" ] || lock_ok=no
{
  echo "files in arm tree: $total, mismatched: $bad, missing: $missing, extra: $extra, untracked: $nun"
  echo "package-lock.json matches the arm: $lock_ok (installed node_modules files are not hashed)"
} >> "$OUT"
[ "$total" -gt 0 ] && [ "$bad" = 0 ] && [ "$missing" = 0 ] && [ "$extra" = 0 ] && [ "$nun" = 0 ] && [ "$lock_ok" = yes ] || fail "see the lines above"
echo "RESULT: MATCH" >> "$OUT"
exit 0
