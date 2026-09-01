import { createRoute } from "@tanstack/react-router"

import { PlansPage } from "../components/plans-page"
import { rootRoute } from "./__root"

export const plansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans",
  component: PlansPage,
})
