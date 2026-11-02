#!/usr/bin/env bash
# Puts this fork's commits on top of an upstream release: ours/<BASE_TAG> rebased onto <TAG>.
# Only git runs here, no code from the repository, so the job may be trusted with its outputs.
#
# Env: BASE_BRANCH (ours/vX), BASE_TAG (vX), TAG (new upstream tag), OUT (artifact directory).
# Run inside a full clone of this fork with BASE_BRANCH checked out.
# Outputs: result=ok|conflict, head, conflicts, stopped_at. A conflict is a result, not an error.
set -euo pipefail
: "${BASE_BRANCH:?}" "${BASE_TAG:?}" "${TAG:?}" "${OUT:?}"
UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/${UPSTREAM:-fakechris/lumenbox}.git}
mkdir -p "$OUT"
out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; else printf '%s=%s\n' "$1" "$2"; fi; }

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch --no-tags --force "$UPSTREAM_URL" "refs/tags/$BASE_TAG:refs/tags/$BASE_TAG" "refs/tags/$TAG:refs/tags/$TAG"
git merge-base --is-ancestor "$BASE_TAG" "$BASE_BRANCH" || { echo "$BASE_BRANCH is not based on $BASE_TAG" >&2; exit 1; }
echo "replaying $(git rev-list --count "$BASE_TAG..$BASE_BRANCH") commits from $BASE_BRANCH onto $TAG"

git switch -q -C candidate "$BASE_BRANCH"
if git -c rerere.enabled=false rebase --onto "$TAG" "$BASE_TAG" > "$OUT/rebase.log" 2>&1; then
  out result ok
  out head "$(git rev-parse HEAD)"
  git range-diff --no-color "$BASE_TAG..$BASE_BRANCH" "$TAG..candidate" > "$OUT/range-diff.txt" || true
  git bundle create "$OUT/candidate.bundle" candidate "^$TAG"
  git log --oneline "$TAG..candidate"
else
  conflicts=$(git diff --name-only --diff-filter=U | tr '\n' ' ' | sed 's/ $//')
  stopped=$(git log -1 --format='%h %s' "$(cat .git/rebase-merge/stopped-sha 2>/dev/null || git rev-parse REBASE_HEAD)" 2>/dev/null || echo unknown)
  cat "$OUT/rebase.log"
  git rebase --abort
  out result conflict
  out conflicts "${conflicts:-unknown}"
  out stopped_at "$stopped"
  echo "conflict at $stopped: $conflicts"
fi
