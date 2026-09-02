#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR=/etc/systemd/system
SERVICE_NAME=hdu-library-sniper-auto-update.service
TIMER_NAME=hdu-library-sniper-auto-update.timer
ENV_FILE=/etc/default/hdu-library-sniper-auto-update
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$REPO_DIR/scripts/podman-auto-update.sh"

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

if [[ ! -f "$ENV_FILE" ]]; then
  install -d -m 0755 "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
# Deployment settings for the HDU Library Sniper auto-update job.
# This file deliberately contains no account credentials. The application keeps
# its session data in the named Podman volume.
HDU_SNIPER_REPO_DIR=$REPO_DIR
HDU_SNIPER_REMOTE=origin
HDU_SNIPER_BRANCH=main
HDU_SNIPER_CONTAINER_NAME=hdu-library-sniper
HDU_SNIPER_IMAGE=localhost/hdu-library-sniper:dev
HDU_SNIPER_VOLUME=hdu-sniper-data
HDU_SNIPER_ENV_FILE=$REPO_DIR/.env.local
HDU_SNIPER_BIND_ADDRESS=0.0.0.0
HDU_SNIPER_HOST_PORT=8000
HDU_SNIPER_READY_TIMEOUT_SECONDS=45
EOF
  chmod 0640 "$ENV_FILE"
fi

cat > "$UNIT_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=HDU Library Sniper safe Podman auto-update
Wants=network-online.target
After=network-online.target podman-restart.service

[Service]
Type=oneshot
KillMode=process
TimeoutStartSec=30min
TimeoutStopSec=15s
EnvironmentFile=-$ENV_FILE
ExecStart=$SCRIPT_PATH
EOF

cat > "$UNIT_DIR/$TIMER_NAME" <<EOF
[Unit]
Description=Check for HDU Library Sniper updates every day

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
echo "enabled $TIMER_NAME (daily at 03:15 Asia/Shanghai, randomized up to 15 minutes)"
echo "configuration: $ENV_FILE"
