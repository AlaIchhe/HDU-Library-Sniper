"""冻结打包环境的基础运行引导。"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def configure_packaged_browser() -> Path | None:
    """Point Playwright at Chromium bundled with a frozen desktop app."""
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
    if configured:
        return Path(configured)
    if not getattr(sys, "frozen", False):
        return None

    executable_dir = Path(sys.executable).resolve().parent
    bundle_dir = Path(getattr(sys, "_MEIPASS", executable_dir))
    for candidate in (
        bundle_dir / "playwright-browsers",
        executable_dir / "playwright-browsers",
    ):
        if candidate.is_dir():
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(candidate)
            return candidate
    return None
