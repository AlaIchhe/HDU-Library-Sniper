#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
podman volume exists hdu-sniper-data || podman volume create hdu-sniper-data >/dev/null
podman rm -f hdu-library-sniper >/dev/null 2>&1 || true
podman run --name hdu-library-sniper \
  --env-file .env.local \
  -e HDU_SNIPER_HOME=/var/lib/hdu-sniper \
  -e HDU_WEB_PORT=8000 \
  -e HDU_BOOKING_SCHEDULER_INSTALLED=1 \
  -p "${HDU_WEB_PORT:-8000}:8000" \
  -v hdu-sniper-data:/var/lib/hdu-sniper:Z \
  --restart=unless-stopped \
  -d localhost/hdu-library-sniper:dev

if [[ "${HDU_SKIP_SYSTEMD_SCHEDULER:-0}" != "1" ]]; then
  "$(dirname "${BASH_SOURCE[0]}")/install-systemd-scheduler.sh"
fi

podman logs --tail 20 hdu-library-sniper
