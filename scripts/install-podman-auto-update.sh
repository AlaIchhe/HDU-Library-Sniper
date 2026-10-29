#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR=/etc/systemd/system
SERVICE_NAME=hdu-library-sniper-auto-update.service
TIMER_NAME=hdu-library-sniper-auto-update.timer
ENV_FILE=/etc/default/hdu-library-sniper-auto-update
INSTALL_PATH=/usr/local/sbin/hdu-library-sniper-auto-update
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$REPO_DIR/scripts/podman-auto-update.sh"
IMAGE=${HDU_SNIPER_IMAGE:-ghcr.io/alaichhe/hdu-library-sniper:latest}
CONTAINER_NAME=${HDU_SNIPER_CONTAINER_NAME:-hdu-library-sniper}

if [[ ${EUID} -ne 0 ]]; then
  echo "Podman auto-update installation requires root; run with sudo." >&2
  exit 77
fi
if [[ ! -x /usr/bin/podman ]]; then
  echo "podman was not found at /usr/bin/podman." >&2
  exit 78
fi
if [[ ! -x "$SCRIPT_PATH" ]]; then
  echo "auto-update script was not found or is not executable: $SCRIPT_PATH" >&2
  exit 79
fi

# 部署机只运行镜像，不再需要 Git 工作区：把脚本安装到 /usr/local/sbin，
# systemd 指向这个副本，因此移动/删除仓库目录都不会影响定时更新。
install -d -m 0755 "$(dirname "$INSTALL_PATH")"
install -m 0755 "$SCRIPT_PATH" "$INSTALL_PATH"

if [[ ! -f "$ENV_FILE" ]]; then
  install -d -m 0755 "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
# Deployment settings for the HDU Library Sniper auto-update job.
# This file deliberately contains no account credentials. The application keeps
# its session data in the named Podman volume.
#
# The image is published by .github/workflows/image.yml. If the GitHub Container
# Registry package is private, run "podman login ghcr.io" once on this host.
HDU_SNIPER_IMAGE=$IMAGE
HDU_SNIPER_CONTAINER_NAME=$CONTAINER_NAME
HDU_SNIPER_VOLUME=hdu-sniper-data
HDU_SNIPER_ENV_FILE=/etc/hdu-sniper/env
HDU_SNIPER_BIND_ADDRESS=0.0.0.0
HDU_SNIPER_HOST_PORT=8000
HDU_SNIPER_READY_TIMEOUT_SECONDS=60
HDU_SNIPER_PRUNE_IMAGES=1
EOF
  chmod 0640 "$ENV_FILE"
fi

cat > "$UNIT_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=HDU Library Sniper image auto-update
Wants=network-online.target
After=network-online.target podman-restart.service

[Service]
Type=oneshot
KillMode=process
TimeoutStartSec=30min
TimeoutStopSec=15s
EnvironmentFile=-$ENV_FILE
ExecStart=$INSTALL_PATH
EOF

cat > "$UNIT_DIR/$TIMER_NAME" <<EOF
[Unit]
Description=Check for HDU Library Sniper image updates every day

[Timer]
OnCalendar=*-*-* 03:15:00 Asia/Shanghai
Persistent=true
RandomizedDelaySec=15m
Unit=$SERVICE_NAME

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$TIMER_NAME"
echo "installed $INSTALL_PATH"
echo "enabled $TIMER_NAME (daily at 03:15 Asia/Shanghai, randomized up to 15 minutes)"
echo "configuration: $ENV_FILE"
echo "pull check: podman pull $IMAGE"
