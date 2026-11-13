#!/usr/bin/env bash
# Daily database backup (keep 14). Add to cron:  15 2 * * * /path/to/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p backups
f="backups/golden-$(date +%F-%H%M).dump"
docker compose exec -T db pg_dump -U golden_owner -d golden -Fc > "$f"
[ -s "$f" ] || { echo "backup is empty!"; exit 1; }
ls -1t backups/golden-*.dump | tail -n +15 | xargs -r rm --
echo "backup written: $f ($(du -h "$f" | cut -f1)) — copy it off this server too"
# restore (stops writes first):  docker compose stop api && docker compose exec -T db pg_restore -U golden_owner -d golden --clean --if-exists < FILE && docker compose start api
