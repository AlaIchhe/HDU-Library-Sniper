import { createRouter } from "@tanstack/react-router"

import { rootRoute } from "./__root"
import { loginRoute } from "./login"
import { plansRoute } from "./plans"
import { bookingsRoute } from "./bookings"

const routeTree = rootRoute.addChildren([loginRoute, plansRoute, bookingsRoute])

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
