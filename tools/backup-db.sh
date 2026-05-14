#!/usr/bin/env bash
# SQLite online-backup snapshot for EvilQuest. WAL-safe — uses sqlite3's
# Online Backup API so the running server doesn't have to stop.
#
# Retention: 7 most recent daily snapshots + 4 most recent weekly (Sunday).
# Backups are kept on the same host as the live DB — protects against volume
# wipe / docker mistakes / SQLite corruption, NOT disk failure or host loss.
#
# Install (once, as root on host):
#   ln -sf /opt/evilquest/tools/backup-db.sh /etc/cron.daily/evilquest-backup
#   (or add a crontab entry: `5 3 * * * /opt/evilquest/tools/backup-db.sh`)
#
# Restore: see tools/restore-db.md
set -euo pipefail

DB_SRC="/var/lib/docker/volumes/evilquest_evilquest_data/_data/projectrs.db"
BACKUP_DIR="/opt/evilquest-backups"
DAILY_KEEP=7
WEEKLY_KEEP=4

[ -f "$DB_SRC" ] || { echo "DB not found at $DB_SRC" >&2; exit 1; }
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

TS=$(date +%Y%m%d-%H%M%S)
DOW=$(date +%u)  # 1-7, 7=Sun
OUT="$BACKUP_DIR/daily/projectrs-$TS.db"

# Online backup via SQLite Backup API — atomic, includes WAL state.
sqlite3 "$DB_SRC" ".backup '$OUT'"
chmod 600 "$OUT"

# Integrity check — abort retention prune if backup is corrupt.
if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -q '^ok$'; then
  echo "Backup $OUT failed integrity_check" >&2
  exit 2
fi

# Sunday → also copy into weekly bucket
if [ "$DOW" = "7" ]; then
  cp -p "$OUT" "$BACKUP_DIR/weekly/projectrs-$TS.db"
fi

# Prune oldest beyond retention. ls -1t = newest first; tail -n +N drops top N-1.
ls -1t "$BACKUP_DIR/daily"/projectrs-*.db 2>/dev/null  | tail -n +$((DAILY_KEEP+1))  | xargs -r rm -f
ls -1t "$BACKUP_DIR/weekly"/projectrs-*.db 2>/dev/null | tail -n +$((WEEKLY_KEEP+1)) | xargs -r rm -f

# Size + count for log
DSIZE=$(du -h "$OUT" | cut -f1)
DC=$(ls "$BACKUP_DIR/daily"/projectrs-*.db 2>/dev/null | wc -l)
WC=$(ls "$BACKUP_DIR/weekly"/projectrs-*.db 2>/dev/null | wc -l)
echo "[$(date -Iseconds)] backup ok: $OUT ($DSIZE)  daily=$DC weekly=$WC"
