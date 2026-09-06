#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
podman volume exists hdu-sniper-data || podman volume create hdu-sniper-data >/dev/null
podman rm -f hdu-library-sniper >/dev/null 2>&1 || true
revision="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
run_args=(
  --name hdu-library-sniper
  -e HDU_SNIPER_HOME=/var/lib/hdu-sniper
  -e HDU_WEB_PORT=8000
  -p "${HDU_WEB_PORT:-8000}:8000"
  -v hdu-sniper-data:/var/lib/hdu-sniper:Z
  --restart=always
  --health-cmd='wget -qO- http://127.0.0.1:8000/api/health'
  --health-interval=30s
  --health-timeout=5s
  --health-retries=3
  --health-start-period=10s
  --label "com.hdu-library-sniper.source-revision=$revision"
  -d localhost/hdu-library-sniper:dev
)
if [[ -f .env.local ]]; then
  run_args=(--env-file .env.local "${run_args[@]}")
fi
podman run "${run_args[@]}"

if [[ "${HDU_SKIP_SYSTEMD_AUTOSTART:-0}" != "1" ]]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/install-systemd-autostart.sh"
fi

podman logs --tail 20 hdu-library-sniper
