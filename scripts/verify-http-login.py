"""Verify the SSO HTTP login path without writing any local cache.

Usage:
  $env:HDU_STUDENT_ID="..." ; $env:HDU_PASSWORD="..." ; python scripts/verify-http-login.py

The script performs the same GET/parse/AES/POST flow as the app login, then
reports whether CAS redirected back to the library domain. It never stores
the password or session cache.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hdu_sniper.config import load_credentials  # noqa: E402
from hdu_sniper.library.login import (  # noqa: E402
    DESKTOP_UA,
    LOGIN_CAS_ENTRY_URL,
    _build_login_payload,
    _http_login_failure_reason,
    _parse_login_form,
)
from hdu_sniper.paths import resolve_app_paths  # noqa: E402


def main() -> int:
    credentials = load_credentials(resolve_app_paths(os.environ).credentials_file)
    if credentials is None:
        print("Missing credentials. Set HDU_STUDENT_ID and HDU_PASSWORD.")
        return 2

    requests.packages.urllib3.disable_warnings()  # type: ignore[attr-defined]
    session = requests.Session()
    session.verify = False
    session.headers.update(
        {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "User-Agent": DESKTOP_UA,
        },
    )

    try:
        login_page = session.get(
            LOGIN_CAS_ENTRY_URL,
            timeout=(10, 30),
            allow_redirects=True,
        )
        form = _parse_login_form(login_page.text)
        if not form.croypto or not form.execution:
            print("SSO page did not expose croypto/execution.")
            return 1
        response = session.post(
            urljoin(login_page.url, form.action or login_page.url),
            data=_build_login_payload(form, credentials.student_id, credentials.password),
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://sso.hdu.edu.cn",
                "Referer": login_page.url,
            },
            timeout=(10, 30),
            allow_redirects=True,
        )
    except requests.RequestException as exc:
        print(f"HTTP request failed: {exc}")
        return 1

    library_cookies = [
        cookie.name for cookie in session.cookies if "huitu" in (cookie.domain or "")
    ]
    print(f"POST {response.status_code} {response.url}")
    print(f"library cookies: {', '.join(sorted(library_cookies)) or '(none)'}")
    if "huitu.zhishulib.com" in urlparse(response.url).netloc:
        print("SUCCESS: redirected back to library domain.")
        return 0
    print(_http_login_failure_reason(response.text, response.url))
    return 1


if __name__ == "__main__":
    sys.exit(main())
