#!/usr/bin/env bash
set -euo pipefail

systemctl status hdu-library-sniper-auto-update.timer --no-pager
systemctl list-timers hdu-library-sniper-auto-update.timer --all --no-pager
systemctl status hdu-library-sniper-auto-update.service --no-pager
