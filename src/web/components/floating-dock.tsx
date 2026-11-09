"use client"

import { useRef, useState, type PointerEvent } from "react"
import { Link } from "@tanstack/react-router"
import {
  IconCalendarEvent,
  IconCalendarEventFilled,
  IconListCheck,
  IconListCheckFilled,
} from "@tabler/icons-react"
import { motion, useReducedMotion } from "motion/react"

import { useMediaQuery } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"

const BUTTON = 44
const GAP = 6
const PADDING = 6
const MAX_SCALE = 1.18

const ITEMS = [
  {
    to: "/plans" as const,
    label: "预约方案",
    icon: IconListCheck,
    activeIcon: IconListCheckFilled,
  },
  {
    to: "/bookings" as const,
    label: "当前预约",
    icon: IconCalendarEvent,
    activeIcon: IconCalendarEventFilled,
  },
]

/**
 * <1024 宽度的双槽导航。
 *
 * 只有两个目的地，dock 只做导航：44px 命中区、20px 图标、hover 最大 1.18 倍。
 */
export function FloatingDock({
  plansActive,
  bookingsActive,
}: {
  plansActive: boolean
  bookingsActive: boolean
}) {
  const reduced = useReducedMotion()
  const coarsePointer = useMediaQuery({ pointer: "coarse" })
  const interactive = !reduced && !coarsePointer
  const dockRef = useRef<HTMLElement | null>(null)
  const [pointerX, setPointerX] = useState<number | null>(null)

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (!interactive || !dockRef.current) return
    const rect = dockRef.current.getBoundingClientRect()
    setPointerX(event.clientX - rect.left)
  }

  return (
    <nav
      aria-label="主导航"
      className="fixed left-1/2 z-40 flex -translate-x-1/2 items-end gap-1.5 rounded-full border bg-background/80 p-1.5 shadow-lg backdrop-blur-md"
      onPointerLeave={() => setPointerX(null)}
      onPointerMove={handlePointerMove}
      ref={dockRef}
      style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {ITEMS.map((item, index) => {
        const active = item.to === "/plans" ? plansActive : bookingsActive
        const center = PADDING + BUTTON / 2 + index * (BUTTON + GAP)
        const distance = pointerX === null ? Number.POSITIVE_INFINITY : Math.abs(pointerX - center)
        const scale =
          interactive && pointerX !== null ? 1 + (MAX_SCALE - 1) * Math.max(0, 1 - distance / 110) : 1
        const Icon = active ? item.activeIcon : item.icon

        return (
          <motion.div
            animate={{ scale, y: scale > 1.01 ? -3 : 0 }}
            className="group relative"
            key={item.to}
            style={{ transformOrigin: "bottom center" }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 font-medium text-[11px] text-popover-foreground opacity-0 shadow-md transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            >
              {item.label}
            </span>
            <Link
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              className={cn(
                "relative grid size-11 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs dark:bg-foreground/10"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              to={item.to}
            >
              <Icon className="size-5" />
              {active ? (
                <span aria-hidden className="absolute bottom-1 size-1 rounded-full bg-current" />
              ) : null}
            </Link>
          </motion.div>
        )
      })}
    </nav>
  )
}
