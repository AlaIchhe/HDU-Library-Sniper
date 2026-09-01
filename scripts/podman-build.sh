#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec podman build -f Containerfile -t localhost/hdu-library-sniper:dev .
