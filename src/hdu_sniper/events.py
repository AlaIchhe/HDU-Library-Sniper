"""应用任务状态与 UI 事件契约。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any


class JobState(StrEnum):
    IDLE = "idle"
    AUTHENTICATING = "authenticating"
    RUNNING = "running"
    CANCELLING = "cancelling"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EventKind(StrEnum):
    STATE = "state"
    AUTH = "auth"
    AUTH_REQUIRED = "auth_required"
    PROGRESS = "progress"
    RESULT = "result"
    ERROR = "error"


@dataclass(frozen=True)
class ApplicationEvent:
    """从应用层发往任意 UI/API 适配器的稳定事件。"""

    kind: EventKind
    state: JobState
    message: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    occurred_at: datetime = field(default_factory=lambda: datetime.now(UTC))
