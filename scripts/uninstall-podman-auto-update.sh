#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME=hdu-library-sniper-auto-update.service
TIMER_NAME=hdu-library-sniper-auto-update.timer

if [[ ${EUID} -ne 0 ]]; then
  echo "Podman auto-update removal requires root; run with sudo." >&2
  exit 77
fi

systemctl disable --now "$TIMER_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/$SERVICE_NAME" "/etc/systemd/system/$TIMER_NAME"
systemctl daemon-reload
echo "removed $SERVICE_NAME and $TIMER_NAME"
echo "kept /etc/default/hdu-library-sniper-auto-update for reuse; remove it manually if no longer needed."
