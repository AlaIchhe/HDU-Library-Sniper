"""HDU Library Sniper 应用包。"""

__version__ = "1.4.0"

from hdu_sniper.app import SniperApp
from hdu_sniper.events import ApplicationEvent, EventKind, JobState


__all__ = ["ApplicationEvent", "EventKind", "JobState", "SniperApp", "__version__"]
