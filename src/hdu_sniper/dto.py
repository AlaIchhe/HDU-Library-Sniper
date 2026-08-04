"""应用层与展示层共享的稳定数据传输对象。"""

from __future__ import annotations

from dataclasses import dataclass


class UpdateCancelled(RuntimeError):  # noqa: N818
    """Raised when the user cancels an update download."""


class UpdateChecksumError(RuntimeError):
    """Raised when a downloaded installer does not match its release checksum."""


@dataclass(frozen=True)
class DownloadProgress:
    """Download byte counts reported to the UI during an update."""

    downloaded: int
    total: int | None

    @property
    def percent(self) -> float | None:
        return self.downloaded / self.total if self.total else None


@dataclass(frozen=True)
class UpdateInfo:
    """Information needed to download, verify, and install an update."""

    version: str
    tag_name: str
    release_url: str
    download_url: str | None
    sha256: str | None = None
    notes: str | None = None
    published_at: str | None = None


@dataclass(frozen=True)
class SavedCredentialsView:
    """凭据的展示数据，不携带密码。"""

    student_id: str


@dataclass(frozen=True)
class RoomTypeView:
    """房间类型下拉选项。"""

    query: str
    name: str


@dataclass(frozen=True)
class FloorView:
    """楼层及其座位布局的展示数据。"""

    floor_id: str
    room_name: str
    seat_count: int
    seat_titles: list[str]


@dataclass(frozen=True)
class PlanView:
    """预约方案在 UI 中的稳定形状。"""

    plan_id: str | None
    room_name: str
    seat_num: str
    start_hour: int
    duration_hours: int
    fallback_seats: list[str]
    enabled: bool


@dataclass(frozen=True)
class WeekdayOption:
    """星期选择项。"""

    value: int
    label: str


@dataclass(frozen=True)
class SchedulePolicyView:
    """预约日期规则的展示模型，已预计算界面文案。"""

    enabled: bool
    corrupt: bool
    weekdays: frozenset[int]
    summary_label: str
    options: tuple[WeekdayOption, ...]
    next_run_text: str | None = None
    today_excluded: bool = False


@dataclass(frozen=True)
class SchedulerStatusView:
    """系统任务状态的只读展示数据。"""

    exists: bool
    execute_time: str | None = None
    wake_to_run: bool | None = None
    next_run: str | None = None


@dataclass(frozen=True)
class ScheduledTaskView:
    """应用托管系统任务的展示数据。"""

    name: str
    status: str | None = None
    next_run: str | None = None
    last_run: str | None = None
    last_result: str | None = None


@dataclass(frozen=True)
class BookingView:
    """预约记录在 UI 中的稳定形状。"""

    booking_id: str
    room_name: str
    seat_num: str
    start_text: str
    duration_text: str
    status: str
    state: str
    status_label: str
    summary: str
    can_cancel: bool
    can_check_in: bool
    can_sign_out: bool
    can_leave: bool
    can_renew: bool
    show_in_list: bool = True
