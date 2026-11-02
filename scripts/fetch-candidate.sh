#!/usr/bin/env bash
# Puts the candidate source in <dest>, without any credential:
#   MODE=check   the pushed ours/<TAG>, which must contain the upstream tag
#   MODE=rebase  upstream <TAG> plus the rebase job's bundle; HEAD must equal EXPECT_HEAD
# Env: MODE, TAG, REPO (this fork), EXPECT_HEAD (rebase), BUNDLE (default candidate/candidate.bundle).
set -euo pipefail
DEST=${1:?usage: fetch-candidate.sh <dest>}
: "${MODE:?}" "${TAG:?}"
REPO=${REPO:-kyodule/lumenbox}
FORK_URL=${FORK_URL:-https://github.com/$REPO.git}
UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/${UPSTREAM:-fakechris/lumenbox}.git}
BUNDLE=${BUNDLE:-$PWD/candidate/candidate.bundle}

case "$MODE" in
  check)
    git clone -q --filter=blob:none --branch "ours/$TAG" "$FORK_URL" "$DEST"
    git -C "$DEST" fetch -q --no-tags "$UPSTREAM_URL" "refs/tags/$TAG:refs/tags/$TAG"
    git -C "$DEST" merge-base --is-ancestor "$TAG" HEAD || { echo "ours/$TAG does not contain $TAG" >&2; exit 1; }
    ;;
  rebase)
    : "${EXPECT_HEAD:?}"
    git clone -q --depth 1 --branch "$TAG" "$UPSTREAM_URL" "$DEST"
    git -C "$DEST" fetch -q "$BUNDLE" "refs/heads/candidate:refs/heads/candidate"
    git -C "$DEST" switch -q candidate
    test "$(git -C "$DEST" rev-parse HEAD)" = "$EXPECT_HEAD" || { echo "bundle head is not $EXPECT_HEAD" >&2; exit 1; }
    ;;
  *) echo "MODE must be check or rebase" >&2; exit 2 ;;
esac
git -C "$DEST" log --oneline -1
