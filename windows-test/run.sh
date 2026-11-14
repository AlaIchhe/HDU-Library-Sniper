#!/usr/bin/env bash
# Thin podman wrapper around dockur/windows for real NSIS installation testing.
#
#   ./windows-test/run.sh start     # boot the VM, install Windows 11 unattended
#   ./windows-test/run.sh status    # container state + guest notes
#   ./windows-test/run.sh logs      # follow the container log
#   ./windows-test/run.sh web       # print the VNC URL (port 8006)
#   ./windows-test/run.sh stop      # graceful shutdown (guest gets ACPI shutdown)
#   ./windows-test/run.sh destroy   # stop + delete the VM disk (full reinstall)
#
# The first boot downloads a Windows ISO (~6 GB) and installs it (~20-40 min on
# this host). Everything after that is driven by the OEM scripts in ./oem.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NAME=hdu-win-vm
IMAGE=docker.io/dockurr/windows:latest

# 4 cores total on this box, so leave headroom for the host and its containers.
VERSION=${VERSION:-11}
CPU_CORES=${CPU_CORES:-2}
RAM_SIZE=${RAM_SIZE:-6G}
DISK_SIZE=${DISK_SIZE:-64G}

mkdir -p "$HERE/storage" "$HERE/shared/setup" "$HERE/shared/jobs" "$HERE/shared/results"

# The installer is a release artifact, not source: fetch it instead of keeping a
# 4 MB binary in git. Drop any *-setup.exe here to test a specific build.
ensure_setup() {
  if [ -f "$HERE/oem/setup.exe" ]; then
    return 0
  fi
  echo "oem/setup.exe missing, fetching the latest release installer..."
  local url
  url=$(curl -sSL --fail https://api.github.com/repos/AlaIchhe/HDU-Library-Sniper/releases/latest \
    | python3 -c 'import json,sys; print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith("-setup.exe")))')
  curl -L --fail -o "$HERE/oem/setup.exe" "$url"
  echo "downloaded $url"
}

# A Windows ISO fetched once on the host beats dockur downloading it inside the
# container: container egress here runs at ~0.6 MB/s versus ~5 MB/s on the host,
# and the file survives run.sh destroy. Any Windows 10/11 x64 ISO works.
iso_args=()
if [ -f "$HERE/win11.iso" ]; then
  iso_args=(-v "$HERE/win11.iso:/custom.iso")
fi

case "${1:-}" in
  start)
    ensure_setup
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    # --http-proxy=false: the host proxy lives on 127.0.0.1, which is unreachable
    # from inside the container. Without this flag podman forwards HTTP(S)_PROXY
    # and the ISO download dies on "connect 127.0.0.1:7890".
    podman run -d --name "$NAME" \
      --http-proxy=false \
      --device /dev/kvm \
      --device /dev/net/tun \
      --cap-add NET_ADMIN \
      -e "VERSION=$VERSION" \
      -e "CPU_CORES=$CPU_CORES" \
      -e "RAM_SIZE=$RAM_SIZE" \
      -e "DISK_SIZE=$DISK_SIZE" \
      -e USERNAME=Docker \
      -e PASSWORD=admin \
      --dns 1.1.1.1 \
      --dns 8.8.8.8 \
      -p 8006:8006 \
      -p 3389:3389/tcp \
      ${iso_args[@]+"${iso_args[@]}"} \
      -v "$HERE/storage:/storage" \
      -v "$HERE/oem:/oem" \
      -v "$HERE/shared:/shared" \
      --stop-timeout 120 \
      "$IMAGE"
    echo "started $NAME (Windows $VERSION, ${CPU_CORES} vCPU, $RAM_SIZE RAM, $DISK_SIZE disk)"
    echo "VNC:  http://127.0.0.1:8006"
    echo "logs: $HERE/run.sh logs"
    ;;
  status)
    podman ps -a --filter "name=$NAME" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    if podman container exists "$NAME"; then
      echo "--- guest notes ---"
      podman logs --tail 25 "$NAME" 2>&1 | sed -n '1,25p'
    fi
    ;;
  logs)
    exec podman logs -f --tail 60 "$NAME"
    ;;
  web)
    echo "http://127.0.0.1:8006"
    ;;
  stop)
    podman stop "$NAME"
    ;;
  destroy)
    podman rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$HERE/storage" "$HERE/shared/results" "$HERE/shared/jobs"
    mkdir -p "$HERE/storage" "$HERE/shared/results" "$HERE/shared/jobs"
    echo "VM disk deleted; next start reinstalls Windows"
    ;;
  *)
    sed -n '2,16p' "$0"
    exit 1
    ;;
esac
