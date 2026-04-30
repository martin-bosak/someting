#!/usr/bin/env bash
set -euo pipefail

HOSTING_ROOT="${HOSTING_ROOT:-/srv/hosting}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo on the VPS." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg git ufw fail2ban unattended-upgrades rsync logrotate

install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi

. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

id -u "${DEPLOY_USER}" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "${DEPLOY_USER}"
usermod -aG docker "${DEPLOY_USER}"

install -o "${DEPLOY_USER}" -g docker -m 2775 -d \
  "${HOSTING_ROOT}" \
  "${HOSTING_ROOT}/sites" \
  "${HOSTING_ROOT}/caddy/sites" \
  "${HOSTING_ROOT}/caddy/paths" \
  "${HOSTING_ROOT}/caddy/data" \
  "${HOSTING_ROOT}/caddy/config" \
  "${HOSTING_ROOT}/postgres" \
  "${HOSTING_ROOT}/backups" \
  "${HOSTING_ROOT}/logs" \
  "${HOSTING_ROOT}/bin" \
  "${HOSTING_ROOT}/templates"

rsync -a --delete "${REPO_DIR}/scripts/" "${HOSTING_ROOT}/bin/"
rsync -a --delete "${REPO_DIR}/templates/" "${HOSTING_ROOT}/templates/"
chown -R "${DEPLOY_USER}:docker" "${HOSTING_ROOT}/bin" "${HOSTING_ROOT}/templates"
chmod +x "${HOSTING_ROOT}/bin/"*.sh

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now docker
systemctl enable --now fail2ban
systemctl enable --now unattended-upgrades

cat >/etc/logrotate.d/someting <<EOF_LOGROTATE
${HOSTING_ROOT}/logs/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
EOF_LOGROTATE

cat >/etc/cron.d/someting-backups <<EOF_CRON
17 3 * * * ${DEPLOY_USER} ${HOSTING_ROOT}/bin/backup-postgres.sh >> ${HOSTING_ROOT}/logs/backup.log 2>&1
EOF_CRON

echo "Bootstrap complete. Copy .env from .env.example, then run: docker compose up -d --build"
