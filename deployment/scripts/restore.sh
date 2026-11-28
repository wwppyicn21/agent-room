#!/usr/bin/env bash
# Restore a verified snapshot into a target path. Refuses to overwrite by default.
# Usage: restore.sh <backup.db> <target.db> [--force]
set -euo pipefail

BACKUP=${1:?usage: restore.sh <backup.db> <target.db> [--force]}
TARGET=${2:?usage: restore.sh <backup.db> <target.db> [--force]}
FORCE=${3:-}

[[ -f "$BACKUP" ]] || { echo "restore: backup not found: $BACKUP" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "restore: sqlite3 is required" >&2; exit 1; }
CHECK=$(sqlite3 "$BACKUP" 'PRAGMA integrity_check;')
[[ "$CHECK" == "ok" ]] || { echo "restore: backup integrity failed: $CHECK" >&2; exit 1; }
if [[ -e "$TARGET" && "$FORCE" != "--force" ]]; then
  echo "restore: target exists (stop the service, then pass --force): $TARGET" >&2
  exit 2
fi

mkdir -p "$(dirname "$TARGET")"
chmod 700 "$(dirname "$TARGET")"
TMP="$TARGET.restore.$$"
trap 'rm -f "$TMP"' EXIT
sqlite3 "$BACKUP" ".backup '$TMP'"
CHECK=$(sqlite3 "$TMP" 'PRAGMA integrity_check;')
[[ "$CHECK" == "ok" ]] || { echo "restore: copy integrity failed: $CHECK" >&2; exit 1; }
chmod 600 "$TMP"
mv -f "$TMP" "$TARGET"
echo "restore: $TARGET"
