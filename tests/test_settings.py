"""配置目录、优先级和校验测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from config.paths import resolve_app_paths
from config.settings import (
    ConfigError,
    Credentials,
    load_credentials,
    load_settings,
    save_credentials,
)


def test_home_override_uses_portable_layout(tmp_path: Path) -> None:
    paths = resolve_app_paths({"HDU_SNIPER_HOME": str(tmp_path)})

    assert paths.config_dir == tmp_path / "config"
    assert paths.data_dir == tmp_path / "data"
    assert paths.state_dir == tmp_path / "state"
    assert paths.log_dir == tmp_path / "state" / "logs"
    assert all(
        path.is_absolute()
        for path in (paths.config_dir, paths.data_dir, paths.state_dir, paths.log_dir)
    )


def test_load_settings_reads_new_schema(tmp_path: Path) -> None:
    paths = resolve_app_paths({"HDU_SNIPER_HOME": str(tmp_path)})
    paths.config_dir.mkdir(parents=True)
    paths.settings_file.write_text(
        """schema_version: 1
booking:
  max_trials: 8
  retry_delay: 0.5
  dry_run: true
notification:
  wechat_webhook: from-file
""",
        encoding="utf-8",
    )

    settings = load_settings(paths, env={})

    assert settings.max_trials == 8
    assert settings.retry_delay == 0.5
    assert settings.dry_run is True
    assert settings.wechat_webhook == "from-file"


def test_webhook_environment_overrides_file(tmp_path: Path) -> None:
    paths = resolve_app_paths({"HDU_SNIPER_HOME": str(tmp_path)})
    paths.config_dir.mkdir(parents=True)
    paths.settings_file.write_text(
        "schema_version: 1\nnotification:\n  wechat_webhook: from-file\n",
        encoding="utf-8",
    )

    settings = load_settings(paths, env={"HDU_WECHAT_WEBHOOK": "from-env"})

    assert settings.wechat_webhook == "from-env"


def test_invalid_schema_fails_fast(tmp_path: Path) -> None:
    paths = resolve_app_paths({"HDU_SNIPER_HOME": str(tmp_path)})
    paths.config_dir.mkdir(parents=True)
    paths.settings_file.write_text("schema_version: 99\n", encoding="utf-8")

    with pytest.raises(ConfigError, match="不支持的配置版本"):
        load_settings(paths, env={})


def test_legacy_paths_section_is_rejected(tmp_path: Path) -> None:
    paths = resolve_app_paths({"HDU_SNIPER_HOME": str(tmp_path)})
    paths.config_dir.mkdir(parents=True)
    paths.settings_file.write_text(
        "schema_version: 1\npaths:\n  plans_file: config/plans.yaml\n",
        encoding="utf-8",
    )

    with pytest.raises(ConfigError, match="未知配置节点: paths"):
        load_settings(paths, env={})


def test_relative_home_is_rejected() -> None:
    with pytest.raises(ValueError, match="必须是绝对路径"):
        resolve_app_paths({"HDU_SNIPER_HOME": "relative/runtime"})


def test_credentials_support_secret_files(tmp_path: Path) -> None:
    student_id = tmp_path / "student_id"
    password = tmp_path / "password"
    student_id.write_text("123456\n", encoding="utf-8")
    password.write_text("secret\n", encoding="utf-8")

    credentials = load_credentials(
        tmp_path / "unused.yaml",
        env={
            "HDU_STUDENT_ID_FILE": str(student_id),
            "HDU_PASSWORD_FILE": str(password),
        },
    )

    assert credentials == Credentials("123456", "secret")


def test_credentials_round_trip_is_atomic(tmp_path: Path) -> None:
    path = (tmp_path / "data" / "credentials.yaml").resolve()
    expected = Credentials("123456", "secret")

    save_credentials(path, expected)

    assert load_credentials(path, env={}) == expected
    assert not path.with_suffix(".yaml.tmp").exists()
