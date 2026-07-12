"""控制台 + 日志文件 + 微信 webhook 三合一通知。"""

from __future__ import annotations

import contextlib
from datetime import UTC, datetime
from pathlib import Path

import requests


class Notifier:
    """控制台 + 日志文件 + 微信 webhook 三合一通知。"""

    GREEN = "\033[92m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    RESET = "\033[0m"

    def __init__(self, log_file: str | Path, wechat_webhook: str = "") -> None:
        self.log_file = Path(log_file)
        self.wechat_webhook = wechat_webhook

    def send(self, title: str, body: str, success: bool = True) -> None:
        color = self.GREEN if success else self.RED
        print(f"\n{color}{self.BOLD}== {title} =={self.RESET}")
        print(f"{color}{body}{self.RESET}\n")

        try:
            path = self.log_file
            path.parent.mkdir(parents=True, exist_ok=True)
            status = "SUCCESS" if success else "FAILED"
            with path.open("a", encoding="utf-8") as f:
                f.write(f"[{datetime.now(UTC).isoformat()}] [{status}] {title}\n")
                f.write(f"  {body}\n")
                f.write("-" * 50 + "\n")
        except OSError:
            pass

        if self.wechat_webhook:
            with contextlib.suppress(requests.RequestException):
                requests.post(
                    self.wechat_webhook,
                    json={"title": title, "content": body},
                    timeout=10,
                )
