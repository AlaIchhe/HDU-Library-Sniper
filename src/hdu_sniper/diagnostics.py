"""Non-interactive checks used to validate packaged desktop releases."""

from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

from hdu_sniper.library.login import configure_packaged_browser


def desktop_self_check() -> int:
    """Verify that a frozen application can start its bundled browser."""
    browser_path = configure_packaged_browser()
    if getattr(sys, "frozen", False) and browser_path is None:
        return 10
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            browser.close()
    except Exception:
        return 11
    return 0
