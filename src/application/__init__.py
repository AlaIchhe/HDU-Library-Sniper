"""与界面技术无关的应用用例入口。"""

from application.events import ApplicationEvent, EventKind, JobState
from application.facade import SniperApplication, build_application


__all__ = [
    "ApplicationEvent",
    "EventKind",
    "JobState",
    "SniperApplication",
    "build_application",
]
