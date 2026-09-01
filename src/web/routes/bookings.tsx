import { createRoute } from "@tanstack/react-router"

import { BookingsPage } from "../components/bookings-page"
import { rootRoute } from "./__root"

export const bookingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bookings",
  component: BookingsPage,
})
