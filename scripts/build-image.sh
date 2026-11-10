#!/usr/bin/env bash
# Builds the amd64 box image from a source tree the way the upstream release does (xwatchdog,
# boxd/hostd/vendor bundles, docker build), with the engines pinned as that release's notes say.
# Used by CI (to prove it builds) and by the deploy script (to build what runs).
#
#   build-image.sh <src> <image:tag>     build
#   build-image.sh --pins <tag>          print the engine pins and stop
set -euo pipefail
UPSTREAM=${UPSTREAM:-fakechris/lumenbox}

# The release notes are the only place upstream records the engine versions it ships.
pins() {
  curl -fsSL "https://api.github.com/repos/$UPSTREAM/releases/tags/$1" | python3 -c '
import json, re, sys
body = json.load(sys.stdin).get("body") or ""
# Upstream wrote "Claude Code 2.1.250" up to 0.3.12 and "claude 2.1.250" from 0.3.28 on.
names = {"OPENCODE_VERSION": r"opencode", "CLAUDE_CODE_VERSION": r"(?i:claude(?: code)?)", "PI_VERSION": r"\bpi", "MCODE_VERSION": r"\bmcode"}
missing = []
for var, name in names.items():
    m = re.search(name + r"\s+v?(\d+\.\d+\.\d+)", body)
    if m: print(f"{var}={m.group(1)}")
    else: missing.append(var)
if missing: sys.exit("engine versions not found in the release notes: " + ", ".join(missing))
'
}

if [ "${1:-}" = "--pins" ]; then pins "${2:?usage: build-image.sh --pins <tag>}"; exit 0; fi
SRC=$(cd "${1:?usage: build-image.sh <src> <image:tag>}" && pwd)
IMAGE=${2:?usage: build-image.sh <src> <image:tag>}
TAG=${TAG:-v$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/package.json")}
PINS=$(pins "$TAG")
echo "$PINS"
GO=$(sed -n 's/^go \([0-9.]*\).*/\1/p' "$SRC/src/xwatchdog/go.mod")
BUILD_ARGS=()
while IFS= read -r line; do BUILD_ARGS+=(--build-arg "$line"); done <<< "$PINS"

echo "[build] $(date -u +%FT%TZ) xwatchdog (go $GO, linux/amd64)"
docker run --rm -v "$SRC":/src -w /src/src/xwatchdog \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 -e GOFLAGS=-buildvcs=false \
  "golang:$GO-bookworm" go build -ldflags="-s -w" -o /src/docker/box/xwatchdog .
echo "[build] $(date -u +%FT%TZ) npm ci + boxd/hostd/vendor bundles"
docker run --rm -v "$SRC":/src -w /src -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 node:22-bookworm-slim \
  sh -c "npm ci --no-audit --no-fund && npm run build:boxd && npm run build:hostd && npm run build:vendor"
echo "[build] $(date -u +%FT%TZ) docker image $IMAGE"
docker build "${BUILD_ARGS[@]}" -t "$IMAGE" "$SRC/docker/box"
docker image inspect "$IMAGE" --format '[build] done: {{.Id}} {{.Architecture}} {{.Size}}'
