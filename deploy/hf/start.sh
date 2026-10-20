#!/usr/bin/env bash
# Entry point of the all-in-one demo container.
set -euo pipefail
mkdir -p "$HOME/data/clips" "$HOME/data/training" "$HOME/data/models" "$HOME/pg"

# Secrets: use the Space secrets when set, otherwise random values for this run.
export RASED_JWT_SECRET="${RASED_JWT_SECRET:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
export RASED_SERVICE_KEY="${RASED_SERVICE_KEY:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
if [ -z "${RASED_ADMIN_PASSWORD:-}" ]; then
  export RASED_ADMIN_PASSWORD="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "RASED_ADMIN_PASSWORD was not set as a Space secret; generated one for this run: $RASED_ADMIN_PASSWORD"
fi

# PostgreSQL in the user's home (Spaces run as uid 1000).
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -1)"
export PATH="$PGBIN:$PATH" PGDATA="$HOME/pg/data"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
  echo "listen_addresses='127.0.0.1'" >> "$PGDATA/postgresql.conf"
  echo "unix_socket_directories='/tmp'" >> "$PGDATA/postgresql.conf"
  pg_ctl -D "$PGDATA" -l "$HOME/pg/log" -w start >/dev/null
  psql -h 127.0.0.1 -U postgres -c "CREATE USER rased WITH PASSWORD 'rased';" -c "CREATE DATABASE rased OWNER rased;" >/dev/null
  pg_ctl -D "$PGDATA" -w stop >/dev/null
fi

exec supervisord -c /app/supervisord.conf
