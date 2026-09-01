import { createRoute } from "@tanstack/react-router"

import { LoginGate } from "../components/login-page"
import { rootRoute } from "./__root"

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LoginGate,
})
