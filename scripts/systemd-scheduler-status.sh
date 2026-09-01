#!/usr/bin/env bash
set -euo pipefail
systemctl status hdu-library-sniper-booking.timer --no-pager
systemctl list-timers hdu-library-sniper-booking.timer --all --no-pager
