# Restore EvilQuest SQLite from a backup

Backups live at `/opt/evilquest-backups/{daily,weekly}/projectrs-YYYYMMDD-HHMMSS.db` on the LCL host. Each is a self-contained SQLite file produced by the Online Backup API (atomic, includes WAL state at snapshot time).

## Restore procedure

```bash
ssh lcl

# 1. Pick a snapshot
ls -lh /opt/evilquest-backups/daily/ /opt/evilquest-backups/weekly/

# 2. Sanity check it
sqlite3 /opt/evilquest-backups/daily/projectrs-<ts>.db 'PRAGMA integrity_check;'
# → ok

# 3. Stop the server (so it releases the live DB)
cd /opt/evilquest && docker compose stop

# 4. Swap in the backup (keep the live file as .preswap in case you change your mind)
VOL=/var/lib/docker/volumes/evilquest_evilquest_data/_data
mv $VOL/projectrs.db     $VOL/projectrs.db.preswap-$(date +%s)
rm -f $VOL/projectrs.db-wal $VOL/projectrs.db-shm   # stale — the backup is a single-file image
cp /opt/evilquest-backups/daily/projectrs-<ts>.db $VOL/projectrs.db
chown root:root $VOL/projectrs.db
chmod 644 $VOL/projectrs.db

# 5. Restart
docker compose up -d
docker logs -f evilquest    # watch for clean boot
```

## Notes

- `docker compose stop` is enough — `down` would also work but removes the container. `down -v` would normally drop the volume too, but the volume is declared `external` so it's protected.
- The `-wal` / `-shm` files are checkpoint state for the *live* DB; replacing the main file invalidates them. Remove before restart.
- If the swapped DB is also bad, restore the `.preswap-*` file the same way to revert.

## Verify backup cron is running

```bash
# Most recent backup line in syslog
journalctl -t CRON --since '1 day ago' | grep evilquest

# Manual run (safe — won't disturb the live server)
/opt/evilquest/tools/backup-db.sh
```
