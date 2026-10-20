#!/usr/bin/env bash
# Pulls main and rebuilds when there are new commits. Run by cron (installed by install.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
exec 9>/tmp/rased-update.lock
flock -n 9 || exit 0
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "[$(date -Is)] updating $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
  git reset -q --hard origin/main
  exec deploy/oracle/install.sh
fi
