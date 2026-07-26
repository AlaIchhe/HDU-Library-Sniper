"""Temporary local server used only for the scheduler browser test."""

from __future__ import annotations

import uvicorn

from hdu_sniper.booking.models import BookingPlan
from hdu_sniper.runtime import get_app


application = get_app()
application._authenticated = True
application.try_cached_authentication = lambda: True
application.plans.list_all = lambda: []
application.plans.list_enabled = lambda: [BookingPlan(1, 1, "A001", 8, 4)]
application.plans.list_room_types = lambda: []

uvicorn.run("hdu_sniper.server:app", host="127.0.0.1", port=8766)
