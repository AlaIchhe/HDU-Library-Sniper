"""业务配置和凭据加载。"""

from __future__ import annotations

import contextlib
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import yaml

from hdu_sniper.paths import AppPaths, resolve_app_paths


SCHEMA_VERSION = 1

CHECK_IN_AGREEMENT_VERSION = "2026-08-02.1"
CHECK_IN_AGREEMENT_TEXT = (
    "自动签到功能会代替你向图书馆平台发起签到请求。启用前请确认：\n"
    "1. 该行为可能违反学校或图书馆平台的使用规则，存在账号被封禁、"
    "预约资格受限等风险；\n"
    "2. 本工具仅按你配置的计划自动执行，不对任何账号处罚或预约失效"
    "承担后果；\n"
    "3. 你可以随时在“调度”页关闭自动签到，关闭后已创建的系统任务"
    "会被移除。\n"
    "勾选即表示你已阅读并知悉上述风险，自愿承担由此产生的全部后果。"
)


class ConfigError(ValueError):
    """配置文件存在但内容无效。"""


@dataclass(frozen=True)
class Settings:
    """抢座工具运行配置。"""

    paths: AppPaths
    max_trials: int = 5
    retry_delay: float = 1.0
    dry_run: bool = False
    window_wait_seconds: float = 30.0
    window_poll_interval: float = 1.0
    wechat_webhook: str = ""
    auto_check_in_enabled: bool = False
    auto_check_in_agreement_version: str = ""
    auto_check_in_agreed_at: str = ""
    check_in_retry_interval: float = 120.0


@dataclass(frozen=True)
class Credentials:
    """杭电统一身份认证凭据（学号 + 数字杭电密码）。"""

    student_id: str
    password: str


def _mapping(value: object, name: str) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError(f"配置项 {name} 必须是映射")
    return value


def load_settings(
    paths: AppPaths | None = None,
    env: Mapping[str, str] | None = None,
) -> Settings:
    """从标准配置目录加载业务设置，文件缺失时使用内置默认值。"""
    environ = os.environ if env is None else env
    app_paths = paths or resolve_app_paths(environ)
    settings_file = app_paths.settings_file
    data: dict = {}

    if settings_file.exists():
        try:
            loaded = yaml.safe_load(settings_file.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            raise ConfigError(f"无法读取配置文件 {settings_file}: {exc}") from exc
        data = _mapping(loaded, "根节点")
        version = data.get("schema_version")
        if version != SCHEMA_VERSION:
            raise ConfigError(
                f"不支持的配置版本 {version!r}，当前版本为 {SCHEMA_VERSION}: {settings_file}",
            )
        unknown_sections = set(data) - {
            "schema_version",
            "booking",
            "notification",
            "auto_check_in",
        }
        if unknown_sections:
            names = ", ".join(sorted(unknown_sections))
            raise ConfigError(f"未知配置节点: {names}: {settings_file}")

    booking = _mapping(data.get("booking"), "booking")
    notification = _mapping(data.get("notification"), "notification")
    auto_check_in = _mapping(data.get("auto_check_in"), "auto_check_in")
    webhook = environ.get("HDU_WECHAT_WEBHOOK", "").strip()
    dry_run = booking.get("dry_run", False)
    if not isinstance(dry_run, bool):
        raise ConfigError(f"booking.dry_run 必须是布尔值: {settings_file}")
    check_in_enabled = auto_check_in.get("enabled", False)
    if not isinstance(check_in_enabled, bool):
        raise ConfigError(f"auto_check_in.enabled 必须是布尔值: {settings_file}")

    try:
        settings = Settings(
            paths=app_paths,
            max_trials=int(booking.get("max_trials", 5)),
            retry_delay=float(booking.get("retry_delay", 1.0)),
            dry_run=dry_run,
            window_wait_seconds=float(booking.get("window_wait_seconds", 30.0)),
            window_poll_interval=float(booking.get("window_poll_interval", 1.0)),
            wechat_webhook=webhook or str(notification.get("wechat_webhook", "")),
            auto_check_in_enabled=check_in_enabled,
            auto_check_in_agreement_version=str(
                auto_check_in.get("agreement_version", "")
            ),
            auto_check_in_agreed_at=str(auto_check_in.get("agreed_at", "")),
            check_in_retry_interval=float(auto_check_in.get("retry_interval", 120.0)),
        )
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"配置字段类型错误: {settings_file}: {exc}") from exc
    if settings.max_trials < 1:
        raise ConfigError("booking.max_trials 必须至少为 1")
    if settings.retry_delay < 0:
        raise ConfigError("booking.retry_delay 不能为负数")
    if settings.window_wait_seconds < 0 or settings.window_poll_interval <= 0:
        raise ConfigError("预约窗口等待时间不能为负，轮询间隔必须大于 0")
    if settings.check_in_retry_interval <= 0:
        raise ConfigError("auto_check_in.retry_interval 必须大于 0")
    return settings


def save_settings(settings: Settings, path: str | Path) -> None:
    """将业务配置原子写入 YAML 文件，供自动签到等运行时开关使用。"""
    data = {
        "schema_version": SCHEMA_VERSION,
        "booking": {
            "max_trials": settings.max_trials,
            "retry_delay": settings.retry_delay,
            "dry_run": settings.dry_run,
            "window_wait_seconds": settings.window_wait_seconds,
            "window_poll_interval": settings.window_poll_interval,
        },
        "notification": {"wechat_webhook": settings.wechat_webhook},
        "auto_check_in": {
            "enabled": settings.auto_check_in_enabled,
            "agreement_version": settings.auto_check_in_agreement_version,
            "agreed_at": settings.auto_check_in_agreed_at,
            "retry_interval": settings.check_in_retry_interval,
        },
    }
    settings_path = Path(path).expanduser()
    if not settings_path.is_absolute():
        raise ValueError(f"配置路径必须是绝对路径: {settings_path}")
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = settings_path.with_suffix(f"{settings_path.suffix}.tmp")
    temporary_path.write_text(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    temporary_path.replace(settings_path)


def _secret_from_env(name: str, environ: Mapping[str, str]) -> str:
    value = environ.get(name, "").strip()
    file_value = environ.get(f"{name}_FILE", "").strip()
    if value and file_value:
        raise ConfigError(f"{name} 与 {name}_FILE 不能同时设置")
    if value:
        return value
    if not file_value:
        return ""
    try:
        return Path(file_value).read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ConfigError(f"无法读取 {name}_FILE={file_value}: {exc}") from exc


def load_credentials(
    path: str | Path,
    env: Mapping[str, str] | None = None,
) -> Credentials | None:
    """优先从环境变量或 secret 文件读取凭据，其次读取桌面端凭据文件。"""
    environ = os.environ if env is None else env
    sid = _secret_from_env("HDU_STUDENT_ID", environ)
    password = _secret_from_env("HDU_PASSWORD", environ)
    if sid or password:
        if not sid or not password:
            raise ConfigError("HDU_STUDENT_ID 与 HDU_PASSWORD 必须成对提供")
        return Credentials(student_id=sid, password=password)

    credential_path = Path(path).expanduser()
    if not credential_path.is_absolute():
        raise ValueError(f"凭据路径必须是绝对路径: {credential_path}")
    if not credential_path.exists():
        return None
    try:
        data = yaml.safe_load(credential_path.read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, OSError):
        return None
    sid = str(data.get("student_id", "")).strip()
    password = str(data.get("password", "")).strip()
    if sid and password:
        return Credentials(student_id=sid, password=password)
    return None


def save_credentials(path: str | Path, creds: Credentials) -> None:
    """将桌面端凭据原子写入用户数据目录。"""
    credential_path = Path(path).expanduser()
    if not credential_path.is_absolute():
        raise ValueError(f"凭据路径必须是绝对路径: {credential_path}")
    credential_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = credential_path.with_suffix(f"{credential_path.suffix}.tmp")
    temporary_path.write_text(
        yaml.safe_dump(
            {"student_id": creds.student_id, "password": creds.password},
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    with contextlib.suppress(OSError):
        temporary_path.chmod(0o600)
    temporary_path.replace(credential_path)
