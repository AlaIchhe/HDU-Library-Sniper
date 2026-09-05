#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR=/etc/systemd/system
SERVICE_NAME=hdu-library-sniper.service
CONTAINER_NAME=${HDU_SNIPER_CONTAINER_NAME:-hdu-library-sniper}
PODMAN_BIN=${PODMAN_BIN:-/usr/bin/podman}

if [[ ${EUID} -ne 0 ]]; then
  echo "systemd autostart installation requires root; run with sudo." >&2
  exit 77
fi
if [[ ! -x "$PODMAN_BIN" ]]; then
  echo "podman was not found at $PODMAN_BIN." >&2
  exit 78
fi

cat > "$UNIT_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=HDU Library Sniper container autostart
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$PODMAN_BIN start $CONTAINER_NAME

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
echo "enabled $SERVICE_NAME to start container $CONTAINER_NAME at boot"
