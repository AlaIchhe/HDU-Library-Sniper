"""控制台 + 日志文件 + 微信 webhook + 系统通知。"""

from __future__ import annotations

import base64
import contextlib
import json
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import requests


APP_NAME = "HDU Library Sniper"


class Notifier:
    """控制台 + 日志文件 + 微信 webhook + 系统通知。"""

    GREEN = "\033[92m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    RESET = "\033[0m"

    def __init__(self, log_file: str | Path, wechat_webhook: str = "") -> None:
        self.log_file = Path(log_file)
        self.wechat_webhook = wechat_webhook

    @staticmethod
    def _console_safe(value: str) -> str:
        """让 Windows 非 UTF-8 控制台无法表示的字符变成可输出占位符。"""
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        return value.encode(encoding, errors="replace").decode(encoding, errors="replace")

    def send(self, title: str, body: str, success: bool = True) -> None:
        color = self.GREEN if success else self.RED
        print(self._console_safe(f"\n{color}{self.BOLD}== {title} =={self.RESET}"))
        print(self._console_safe(f"{color}{body}{self.RESET}\n"))

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

        if success:
            with contextlib.suppress(Exception):
                _system_notify(title, body)


def _powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _windows_system_notify(title: str, body: str) -> None:
    script = f"""
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$mgr = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$template = $mgr::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($template.CreateTextNode({_powershell_quote(title)})) | Out-Null
$textNodes.Item(1).AppendChild($template.CreateTextNode({_powershell_quote(body)})) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
try {{ $mgr::CreateToastNotifier({_powershell_quote(APP_NAME)}).Show($toast) }}
catch {{ $mgr::CreateToastNotifier('Microsoft.Windows.PowerShell').Show($toast) }}
"""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            encoded,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _macos_system_notify(title: str, body: str) -> None:
    script = (
        "display notification "
        f"{json.dumps(body, ensure_ascii=False)} "
        "with title "
        f"{json.dumps(title, ensure_ascii=False)}"
    )
    subprocess.Popen(
        ["/usr/bin/osascript", "-e", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _linux_system_notify(title: str, body: str) -> None:
    notify_send = shutil.which("notify-send")
    if not notify_send:
        return
    subprocess.Popen(
        [notify_send, "--app-name", APP_NAME, title, body],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _system_notify(title: str, body: str) -> None:
    if sys.platform == "win32":
        _windows_system_notify(title, body)
    elif sys.platform == "darwin":
        _macos_system_notify(title, body)
    else:
        _linux_system_notify(title, body)
