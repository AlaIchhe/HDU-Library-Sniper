#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "systemd timer removal requires root; run with sudo." >&2
  exit 77
fi

systemctl disable --now hdu-library-sniper-booking.timer 2>/dev/null || true
rm -f /etc/systemd/system/hdu-library-sniper-booking.timer /etc/systemd/system/hdu-library-sniper-booking.service
systemctl daemon-reload
echo "removed HDU Library Sniper booking timer"
