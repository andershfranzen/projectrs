# Restore EvilQuest SQLite and forum media from a backup

Backups live at `/opt/evilquest-backups/{daily,weekly}/` on the LCL host. Each run writes a self-contained SQLite file (`projectrs-YYYYMMDD-HHMMSS.db`) plus a matching forum media/avatar archive (`projectrs-media-YYYYMMDD-HHMMSS.tar.gz`).

## Restore procedure

```bash
ssh lcl

# 1. Pick a snapshot
ls -lh /opt/evilquest-backups/daily/ /opt/evilquest-backups/weekly/

# 2. Sanity check it and confirm the matching media archive exists
sqlite3 /opt/evilquest-backups/daily/projectrs-<ts>.db 'PRAGMA integrity_check;'
# → ok
test -f /opt/evilquest-backups/daily/projectrs-media-<ts>.tar.gz

# 3. Stop the server (so it releases the live DB)
cd /opt/evilquest && docker compose stop

# 4. Swap in the backup (keep the live file as .preswap in case you change your mind)
VOL=/var/lib/docker/volumes/evilquest_evilquest_data/_data
mv $VOL/projectrs.db     $VOL/projectrs.db.preswap-$(date +%s)
rm -f $VOL/projectrs.db-wal $VOL/projectrs.db-shm   # stale — the backup is a single-file image
cp /opt/evilquest-backups/daily/projectrs-<ts>.db $VOL/projectrs.db
chown root:root $VOL/projectrs.db
chmod 644 $VOL/projectrs.db

# 4b. Restore the media files that match the DB rows
MEDIA_PRESWAP=$VOL/forum-media.preswap-$(date +%s)
AVATAR_PRESWAP=$VOL/forum-avatars.preswap-$(date +%s)
mkdir -p "$MEDIA_PRESWAP" "$AVATAR_PRESWAP" "$VOL/forum-media" "$VOL/forum-avatars"
mv "$VOL/forum-media"/* "$MEDIA_PRESWAP"/ 2>/dev/null || true
mv "$VOL/forum-avatars"/* "$AVATAR_PRESWAP"/ 2>/dev/null || true
tar -C "$VOL" -xzf /opt/evilquest-backups/daily/projectrs-media-<ts>.tar.gz

# 5. Restart
docker compose up -d
docker logs -f evilquest    # watch for clean boot
```

## Notes

- `docker compose stop` is enough. Avoid `docker compose down -v`; it removes the named volume that stores the DB and forum media.
- The `-wal` / `-shm` files are checkpoint state for the *live* DB; replacing the main file invalidates them. Remove before restart.
- Restore the matching `projectrs-media-<ts>.tar.gz` with the DB, otherwise forum posts and profiles can point at missing image files.
- If the swapped DB is also bad, restore the `.preswap-*` file the same way to revert.

## Verify backup cron is running

```bash
# Most recent backup line in syslog
journalctl -t CRON --since '1 day ago' | grep evilquest

# Manual run (safe — won't disturb the live server)
/opt/evilquest/tools/backup-db.sh
```
