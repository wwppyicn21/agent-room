#!/usr/bin/env bash
# Online SQLite backup with integrity verification.
# Usage: backup.sh <database> <backup-dir> [keep]
set -euo pipefail

DB=${1:?usage: backup.sh <database> <backup-dir> [keep]}
DIR=${2:?usage: backup.sh <database> <backup-dir> [keep]}
KEEP=${3:-14}

if [[ ! -f "$DB" ]]; then
  echo "backup: database not found: $DB" >&2
  exit 1
fi
if ! [[ "$KEEP" =~ ^[0-9]+$ ]] || (( KEEP < 1 )); then
  echo "backup: keep must be a positive integer" >&2
  exit 1
fi
command -v sqlite3 >/dev/null || { echo "backup: sqlite3 is required" >&2; exit 1; }

mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP="$DIR/.room-$STAMP.$$.tmp"
trap 'rm -f "$TMP"' EXIT

sqlite3 "$DB" ".timeout 5000" ".backup '$TMP'"
CHECK=$(sqlite3 "$TMP" 'PRAGMA integrity_check;')
if [[ "$CHECK" != "ok" ]]; then
  echo "backup: integrity check failed: $CHECK" >&2
  exit 1
fi
chmod 600 "$TMP"
OUT="$DIR/room-$STAMP.db"
mv "$TMP" "$OUT"
sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"
chmod 600 "$OUT.sha256"

# Rotate only our own snapshots; never touch unrelated files.
mapfile -t OLD < <(ls -1t "$DIR"/room-*.db 2>/dev/null | tail -n "+$((KEEP + 1))" || true)
for file in "${OLD[@]:-}"; do
  [[ -n "$file" ]] || continue
  rm -f "$file" "$file.sha256"
done
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
