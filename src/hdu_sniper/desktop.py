"""Desktop executable entry point, including scheduled background modes.

``--daemon`` / ``--run-now`` 走正常调度路径（应用内按日期规则判断）；
``--override`` 是人工覆盖路径，绕过暂停与星期规则。
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable

from hdu_sniper.application import SniperAppProtocol
from hdu_sniper.ui.flet_view import run_flet_app


def main(application: SniperAppProtocol, *, self_check: Callable[[], int]) -> None:
    if "--self-check" in sys.argv[1:]:
        sys.exit(self_check())

    if "--daemon" in sys.argv[1:] or "--run-now" in sys.argv[1:]:
        execute_at = os.environ.get("HDU_EXECUTE_AT") or None
        for argument in sys.argv[1:]:
            if argument.startswith("--execute-at="):
                execute_at = argument.split("=", 1)[1]
        bypass_policy = "--override" in sys.argv[1:] or os.environ.get("HDU_BYPASS_POLICY") == "1"
        sys.exit(application.run_daemon(execute_at=execute_at, bypass_policy=bypass_policy))

    if "--checkin-run" in sys.argv[1:] or "--checkin-wait" in sys.argv[1:]:
        wait = "--checkin-wait" in sys.argv[1:]
        sys.exit(application.run_checkin(wait=wait))

    run_flet_app(application)
