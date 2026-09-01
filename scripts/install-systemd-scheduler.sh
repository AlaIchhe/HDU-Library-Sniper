#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR=/etc/systemd/system
SERVICE_NAME=hdu-library-sniper-booking.service
TIMER_NAME=hdu-library-sniper-booking.timer
CONTAINER_NAME=${HDU_SNIPER_CONTAINER_NAME:-hdu-library-sniper}
PODMAN_BIN=${PODMAN_BIN:-/usr/bin/podman}

if [[ ${EUID} -ne 0 ]]; then
  echo "systemd timer installation requires root; run with sudo." >&2
  exit 77
fi
if [[ ! -x "$PODMAN_BIN" ]]; then
  echo "podman was not found at $PODMAN_BIN." >&2
  exit 78
fi

cat > "$UNIT_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=HDU Library Sniper booking run
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStartPre=$PODMAN_BIN inspect --format={{.State.Running}} $CONTAINER_NAME
ExecStart=$PODMAN_BIN exec $CONTAINER_NAME bun run booking-run
EOF

cat > "$UNIT_DIR/$TIMER_NAME" <<EOF
[Unit]
Description=HDU Library Sniper daily booking timer

[Timer]
OnCalendar=*-*-* 20:00:00 Asia/Shanghai
Persistent=false
Unit=$SERVICE_NAME

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$TIMER_NAME"
echo "enabled $TIMER_NAME for 20:00 Asia/Shanghai (Persistent=false)"
