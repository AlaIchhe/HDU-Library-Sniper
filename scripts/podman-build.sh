#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
revision="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
exec podman build \
  --build-arg "SOURCE_REVISION=$revision" \
  -f Containerfile \
  -t localhost/hdu-library-sniper:dev \
  .
