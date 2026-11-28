#!/usr/bin/env bash
# Atomically point a symlink at a release directory; keeps the previous release
# on disk so the same command can roll back.
# Usage: switch-release.sh <releases-dir> <release-id> <current-symlink>
set -euo pipefail

RELEASES=${1:?usage: switch-release.sh <releases-dir> <release-id> <current-symlink>}
RELEASE=${2:?usage: switch-release.sh <releases-dir> <release-id> <current-symlink>}
LINK=${3:?usage: switch-release.sh <releases-dir> <release-id> <current-symlink>}

TARGET="$RELEASES/$RELEASE"
[[ -f "$TARGET/apps/server/dist/main.js" ]] || {
  echo "switch-release: not a built release: $TARGET" >&2
  exit 1
}
PREVIOUS=$(readlink -f "$LINK" 2>/dev/null || true)
mkdir -p "$(dirname "$LINK")"
TMP="$LINK.tmp.$$"
ln -sfn "$TARGET" "$TMP"
mv -Tf "$TMP" "$LINK"
echo "previous=${PREVIOUS:-none}"
echo "current=$TARGET"
