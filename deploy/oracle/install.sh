#!/usr/bin/env bash
# Installs or updates Rased on one Ubuntu server (made for Oracle Cloud Always Free, Ampere A1, Ubuntu 24.04).
# Run as root from the repository folder:  sudo RASED_ADMIN_PASSWORD='...' deploy/oracle/install.sh
# Safe to run again: it keeps the data and the generated secrets.
#
# Optional settings (environment):
#   RASED_ADMIN_PASSWORD  admin password on first start (10+ characters). Generated if missing.
#   RASED_DOMAIN          your own domain name. Default: <public-ip-with-dashes>.sslip.io (free, automatic HTTPS)
#   RASED_DEMO_LOGINS     1 shows the demo accounts on the login page (default), 0 hides them
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CONF=/etc/rased
LOG=/var/log/rased-install.log
say() { echo "[rased $(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
command -v apt-get >/dev/null || { echo "this installer needs Ubuntu (choose the Canonical Ubuntu image)"; exit 1; }
mkdir -p "$CONF" && chmod 700 "$CONF"

# 1. Docker
if ! docker compose version >/dev/null 2>&1; then
  say "installing Docker"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q docker.io docker-compose-v2 git curl iptables-persistent
  systemctl enable --now docker
fi

# 2. Open ports 80 and 443 in the server firewall (Oracle's Ubuntu images block everything except SSH).
#    The cloud firewall (security list) is opened from the Oracle console: docs/hosting.md.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi

# 3. Secrets, generated once and kept in /etc/rased (readable by root only)
rand() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ ! -f "$CONF/app.env" ]; then
  PASS="${RASED_ADMIN_PASSWORD:-}"
  if [ "${#PASS}" -lt 10 ] || ! printf '%s' "$PASS" | LC_ALL=C grep -q '^[ -~]*$'; then
    PASS="$(rand 9)"
    say "RASED_ADMIN_PASSWORD missing, too short or not plain ASCII: generated one"
  fi
  umask 077
  cat > "$CONF/app.env" <<ENV
RASED_ADMIN_PASSWORD=$PASS
RASED_JWT_SECRET=$(rand 32)
RASED_SERVICE_KEY=$(rand 32)
ENV
  echo "$PASS" > "$CONF/admin-password.txt"
fi

# 4. Address: a free sslip.io name for the public IP gives a real HTTPS certificate with no domain to buy.
DOMAIN="${RASED_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f "$CONF/compose.env" ]; then DOMAIN="$(sed -n 's/^RASED_DOMAIN=//p' "$CONF/compose.env")"; fi
if [ -z "$DOMAIN" ]; then
  IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || true)"
  [ -n "$IP" ] || { say "could not find the public IP; set RASED_DOMAIN and run again"; exit 1; }
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
cat > "$CONF/compose.env" <<ENV
RASED_DOMAIN=$DOMAIN
RASED_DEMO_LOGINS=${RASED_DEMO_LOGINS:-1}
ENV

# 5. Build and start (the first build takes 20 to 30 minutes on 2 Ampere cores)
cd "$REPO_DIR"
say "building and starting (first time: 20-30 minutes)"
docker compose -f deploy/oracle/compose.yml --env-file "$CONF/compose.env" up -d --build --remove-orphans 2>&1 | tail -n 20 | tee -a "$LOG"
docker image prune -f >/dev/null 2>&1 || true

# 6. Automatic updates: every 30 minutes, rebuild if main has new commits
cat > /etc/cron.d/rased-update <<CRON
*/30 * * * * root $REPO_DIR/deploy/oracle/update.sh >> /var/log/rased-update.log 2>&1
CRON
chmod +x "$REPO_DIR/deploy/oracle/update.sh"

say "ready: https://$DOMAIN  (user: admin, password in $CONF/admin-password.txt)"
