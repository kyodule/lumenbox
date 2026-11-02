#!/usr/bin/env bash
# Checks that the official signed DMG for <TAG> ships, as upstream source at that tag, the files
# this fork's App install replaces (electron/main.cjs) or loads unchanged (host-runner.ts and
# host-sandbox.ts, imported by electron/host-exec-runner.ts). If it stops doing so, replacing
# main.cjs in the App would mix this fork's shell with a different build.
#
# Env: TAG, GH_TOKEN; DMG_DIR to use a DMG and SHA256SUMS already on disk.
set -euo pipefail
: "${TAG:?}"
UPSTREAM=${UPSTREAM:-fakechris/lumenbox}
VERSION=${TAG#v}
NAME="LumenBox-$VERSION-arm64.dmg"
FILES=(electron/main.cjs src/host/host-runner.ts src/host/host-sandbox.ts)
WORK=$(mktemp -d)
DIR=${DMG_DIR:-$WORK}
if [ -z "${DMG_DIR:-}" ]; then
  gh release download "$TAG" -R "$UPSTREAM" -p "$NAME" -p SHA256SUMS -D "$DIR"
fi
(cd "$DIR" && grep " $NAME\$" SHA256SUMS | shasum -a 256 -c -)
MNT="$WORK/mnt"
mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DIR/$NAME" > /dev/null
trap 'hdiutil detach "$MNT" -quiet || true' EXIT
APP="$MNT/LumenBox.app"
codesign --verify --deep --strict "$APP"
SHIPPED=$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)
[ "$SHIPPED" = "$VERSION" ] || { echo "the DMG says $SHIPPED, expected $VERSION" >&2; exit 1; }
status=0
for file in "${FILES[@]}"; do
  if gh api -H "Accept: application/vnd.github.raw" "repos/$UPSTREAM/contents/$file?ref=$TAG" | cmp -s - "$APP/Contents/Resources/app/$file"; then
    echo "same as $TAG: $file"
  else
    echo "DIFFERENT from $TAG: $file" >&2
    status=1
  fi
done
exit "$status"
