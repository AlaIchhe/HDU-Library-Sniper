"""预约日期策略：摘要、评估、持久化与损坏安全策略测试。"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from hdu_sniper.schedule_policy import (
    ALL_WEEKDAYS,
    SchedulePolicy,
    SchedulePolicyError,
)


def _policy(*days: int, enabled: bool = True) -> SchedulePolicy:
    return SchedulePolicy(enabled=enabled, weekdays=frozenset(days))


def test_summary_labels() -> None:
    assert _policy(*ALL_WEEKDAYS).summary_label() == "每天"
    assert _policy(1, 2, 3, 4, 5).summary_label() == "工作日"
    assert _policy(6, 7).summary_label() == "周末"
    assert _policy(1, 3, 5).summary_label() == "周一、周三、周五"


def test_default_policy_matches_legacy_behavior() -> None:
    policy = SchedulePolicy.default()
    assert policy.enabled is True
    assert policy.weekdays == frozenset(ALL_WEEKDAYS)
    assert policy.summary_label() == "每天"


def test_invalid_weekdays_rejected() -> None:
    with pytest.raises(SchedulePolicyError):
        SchedulePolicy(enabled=True, weekdays=frozenset())
    with pytest.raises(SchedulePolicyError):
        SchedulePolicy(enabled=True, weekdays=frozenset({8}))


def test_evaluate_paused_weekday_mismatch_and_run() -> None:
    monday = date(2026, 8, 3)
    assert _policy(*ALL_WEEKDAYS, enabled=False).evaluate(monday) == (False, "paused")
    assert _policy(6, 7).evaluate(monday) == (False, "weekday_mismatch")
    assert _policy(1).evaluate(monday) == (True, None)


def test_next_booking_date_skips_mismatched_days() -> None:
    # 2026-08-01 是周六；只含周五的规则 → 下一个预约日为 2026-08-07
    assert _policy(5).next_booking_date(date(2026, 8, 1)) == date(2026, 8, 7)


def test_next_booking_date_crosses_month_boundary() -> None:
    # 2026-08-31 是周一；下一个周一为 2026-09-07
    assert _policy(1).next_booking_date(date(2026, 8, 31)) == date(2026, 9, 7)


def test_next_booking_date_respects_two_day_offset() -> None:
    # 最早预约日 = from_date + 2 天
    assert _policy(1).next_booking_date(date(2026, 8, 1)) == date(2026, 8, 3)


def test_next_booking_date_paused_returns_none() -> None:
    assert _policy(1, enabled=False).next_booking_date(date(2026, 8, 1)) is None


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "config" / "schedule-policy.yaml"
    _policy(1, 3, 5).save(path)
    loaded = SchedulePolicy.load(path)
    assert loaded.enabled is True
    assert loaded.weekdays == frozenset({1, 3, 5})
    assert loaded.corrupt is False
    assert loaded.summary_label() == "周一、周三、周五"


def test_load_missing_file_returns_default(tmp_path: Path) -> None:
    policy = SchedulePolicy.load(tmp_path / "missing.yaml")
    assert policy == SchedulePolicy.default()


def test_load_corrupt_file_safely_pauses(tmp_path: Path) -> None:
    path = tmp_path / "schedule-policy.yaml"
    path.write_text("{not valid yaml", encoding="utf-8")
    policy = SchedulePolicy.load(path)
    assert policy.enabled is False
    assert policy.corrupt is True

    path.write_text("enabled: maybe\nweekdays: []\n", encoding="utf-8")
    policy = SchedulePolicy.load(path)
    assert policy.enabled is False
    assert policy.corrupt is True


def test_load_invalid_weekdays_safely_pauses(tmp_path: Path) -> None:
    path = tmp_path / "schedule-policy.yaml"
    path.write_text("enabled: true\nweekdays: [1, 99]\n", encoding="utf-8")
    policy = SchedulePolicy.load(path)
    assert policy.enabled is False
    assert policy.corrupt is True


def test_with_updates_preserves_other_fields() -> None:
    policy = _policy(1, 3, 5)
    updated = policy.with_updates(weekdays=[2, 4])
    assert updated.weekdays == frozenset({2, 4})
    assert updated.enabled is True
    assert updated.corrupt is False
