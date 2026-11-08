"use client"

import { useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  IconCalendarEvent,
  IconCalendarEventFilled,
  IconLibrary,
  IconListCheck,
  IconListCheckFilled,
} from "@tabler/icons-react"

import { cn } from "@/lib/utils"

type RailLinkProps = {
  to: "/plans" | "/bookings"
  label: string
  active: boolean
  expanded: boolean
}

function RailLink({ to, label, active, expanded }: RailLinkProps) {
  const Icon = active
    ? to === "/plans"
      ? IconListCheckFilled
      : IconCalendarEventFilled
    : to === "/plans"
      ? IconListCheck
      : IconCalendarEvent

  return (
    <Link
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className={cn(
        "flex h-11 items-center rounded-lg text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs dark:bg-foreground/10"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        expanded ? "gap-3 px-3" : "justify-center px-0",
      )}
      title={expanded ? undefined : label}
      to={to}
    >
      <Icon className="size-5 shrink-0" />
      <span
        className={cn(
          "whitespace-nowrap transition-opacity",
          expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
        )}
      >
        {label}
      </span>
    </Link>
  )
}

/**
 * 1024–1279 宽度的图标导航。
 *
 * rail 本身固定 64px，展开时不改变内容宽度，而是用 240px 的覆盖层盖在内容上，
 * 避免 hover 时整页横向抖动。
 */
export function HoverRail({
  plansActive,
  bookingsActive,
  runtimeState,
}: {
  plansActive: boolean
  bookingsActive: boolean
  runtimeState: string | undefined
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const expanded = hovered || focused

  const errorState = runtimeState === "error"
  const authRequired = runtimeState === "auth_required"
  const dot = errorState ? "bg-destructive" : authRequired ? "bg-warning" : "bg-success"
  const status = errorState ? "后台服务异常" : authRequired ? "需要重新登录" : "后台服务在线"

  return (
    <aside
      aria-label="侧栏"
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none",
        expanded ? "w-60 shadow-xl/10" : "w-16",
      )}
      data-expanded={expanded}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      onFocusCapture={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex h-14 shrink-0 items-center px-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg">
          <IconLibrary className="size-5" />
        </span>
      </div>

      <nav
        aria-label="主导航"
        className="mt-2 flex flex-1 flex-col gap-1 px-2.5"
        onClickCapture={() => {
          setHovered(false)
          setFocused(false)
        }}
      >
        <RailLink to="/plans" label="预约方案" active={plansActive} expanded={expanded} />
        <RailLink to="/bookings" label="当前预约" active={bookingsActive} expanded={expanded} />
      </nav>

      <div className="shrink-0 p-2.5">
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border bg-card/50 py-2.5",
            expanded ? "px-3" : "justify-center px-0",
          )}
          title={status}
        >
          <span className={cn("size-2 shrink-0 rounded-full", dot)} />
          <span
            className={cn(
              "whitespace-nowrap text-xs text-muted-foreground transition-opacity",
              expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
            )}
          >
            {status}
          </span>
        </div>
      </div>
    </aside>
  )
}
