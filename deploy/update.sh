#!/usr/bin/env bash
# Pull the latest version and restart; pending database migrations run automatically on start.
set -euo pipefail
cd "$(dirname "$0")"
./backup.sh
git -C .. pull --ff-only
./setup.sh
docker compose exec -T api ./node_modules/.bin/tsx scripts/sync-roles.ts || true
