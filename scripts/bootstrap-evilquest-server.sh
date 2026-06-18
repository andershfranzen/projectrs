#!/usr/bin/env bash
set -euo pipefail

DEPLOY_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFKxfTwaOa4nM0OEe2Eh8mAA1k8i2NUYSjH1cbKH5uGh github-actions-evilquest-deploy'
REPO_URL='https://github.com/andershfranzen/projectrs.git'
APP_DIR='/opt/evilquest'

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
grep -qxF "$DEPLOY_KEY" /root/.ssh/authorized_keys || echo "$DEPLOY_KEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl git docker.io docker-compose-plugin
  systemctl enable --now docker || true
fi

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git remote set-url origin "$REPO_URL"
git fetch --depth 1 origin main
git reset --hard origin/main

echo
echo "Bootstrap complete."
echo "Next: rerun the GitHub Actions deploy."
