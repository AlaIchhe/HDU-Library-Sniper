"""Desktop executable entry point, including scheduled background modes."""

from __future__ import annotations

import os
import sys

from hdu_sniper.diagnostics import desktop_self_check
from hdu_sniper.runtime import get_app
from hdu_sniper.ui.app import run_flet_app


def main() -> None:
    if "--self-check" in sys.argv[1:]:
        sys.exit(desktop_self_check())

    if "--daemon" in sys.argv[1:] or "--run-now" in sys.argv[1:]:
        execute_at = os.environ.get("HDU_EXECUTE_AT") or None
        for argument in sys.argv[1:]:
            if argument.startswith("--execute-at="):
                execute_at = argument.split("=", 1)[1]
        sys.exit(get_app().booking.run_once(execute_at=execute_at))

    run_flet_app()
