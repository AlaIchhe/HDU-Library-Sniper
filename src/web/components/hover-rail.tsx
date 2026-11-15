"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"

import { cn } from "@/lib/utils"
import { AnimateIcon, CalendarDays, LibraryBig, ListChecks } from "@/ui/icons"
import { StatusDot } from "./app-shell/status"

/** 指针进入后稍等再展开，避免鼠标掠过左边缘时整条 rail 闪一下。 */
const OPEN_DELAY_MS = 120
/** 离开后稍等再收起，给斜向移出、回头再点留一点余量。 */
const CLOSE_DELAY_MS = 180

/** 文字只做淡入淡出；图标位置固定，展开 / 收起时不会左右跳。 */
const labelClass =
  "whitespace-nowrap transition-opacity duration-150 group-data-[expanded=false]/rail:pointer-events-none group-data-[expanded=false]/rail:opacity-0 group-data-[expanded=true]/rail:delay-75"

type RailLinkProps = {
  to: "/plans" | "/bookings"
  label: string
  shortcut: string
  active: boolean
}

function RailLink({ to, label, shortcut, active }: RailLinkProps) {
  const Icon = to === "/plans" ? ListChecks : CalendarDays

  return (
    <AnimateIcon animateOnHover asChild>
      <Link
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts={shortcut.replace(" ", "+")}
        className={cn(
          // 64px rail 减去两侧 10px 内边距 = 44px；12px + 20px 图标 + 12px 恰好居中
          "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs dark:bg-foreground/10"
            : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        )}
        to={to}
      >
        <Icon className="size-5 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
        <span className={cn(labelClass, "flex-1")}>{label}</span>
        <kbd className={cn(labelClass, "font-sans text-[11px] tracking-widest text-muted-foreground/70")}>
          {shortcut}
        </kbd>
      </Link>
    </AnimateIcon>
  )
}

/**
 * 1024–1279 宽度的图标导航。
 *
 * rail 本身固定 64px，展开时不改变内容宽度，而是用 240px 的覆盖层盖在内容（含顶栏）上，
 * 避免 hover 时整页横向抖动。指针悬停有展开 / 收起延迟；键盘聚焦也会展开，Esc 收起。
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
  // 点击导航或按 Esc 后先收起，直到指针离开 / 焦点移出才重新允许展开。
  const [dismissed, setDismissed] = useState(false)
  const expanded = (hovered || focused) && !dismissed

  const timer = useRef<number | undefined>(undefined)
  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  const scheduleHover = (next: boolean) => {
    clearTimer()
    timer.current = window.setTimeout(() => setHovered(next), next ? OPEN_DELAY_MS : CLOSE_DELAY_MS)
  }

  const collapse = useCallback(() => {
    clearTimer()
    setDismissed(true)
  }, [clearTimer])

  // 悬停展开时焦点通常不在 rail 内，所以 Esc 要在 window 上监听。
  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      collapse()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [expanded, collapse])

  const errorState = runtimeState === "error"
  const authRequired = runtimeState === "auth_required"
  const status = errorState ? "后台服务异常" : authRequired ? "需要重新登录" : "后台服务在线"

  return (
    <aside
      aria-label="侧栏"
      className={cn(
        // z-50：顶栏是 sticky z-40，展开层必须压在它上面，否则 logo 区右侧会被顶栏盖住
        "group/rail fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-[width,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        expanded ? "w-60 shadow-xl/10" : "w-16",
      )}
      data-expanded={expanded}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setFocused(false)
        setDismissed(false)
      }}
      onFocusCapture={(event) => {
        // 只有键盘聚焦才展开；鼠标点击产生的焦点交给 hover 逻辑处理
        if ((event.target as HTMLElement).matches(":focus-visible")) setFocused(true)
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") scheduleHover(true)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return
        scheduleHover(false)
        setDismissed(false)
      }}
    >
      <div className="flex h-14 shrink-0 items-center gap-3 px-3.5">
        <AnimateIcon animateOnHover>
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg">
            <LibraryBig className="size-5" />
          </span>
        </AnimateIcon>
        <strong className={cn(labelClass, "text-sm")}>HDU Sniper</strong>
      </div>

      <nav aria-label="主导航" className="mt-2 flex flex-1 flex-col gap-1 px-2.5" onClickCapture={collapse}>
        <RailLink to="/plans" label="预约方案" shortcut="G P" active={plansActive} />
        <RailLink to="/bookings" label="当前预约" shortcut="G B" active={bookingsActive} />
      </nav>

      <div className="shrink-0 p-2.5">
        <div
          className="flex h-10 items-center gap-2 rounded-xl border bg-card/50 px-[17px]"
          role="status"
          aria-label={status}
          title={expanded ? undefined : status}
        >
          <StatusDot
            tone={errorState ? "bad" : authRequired ? "warn" : "ok"}
            pulse={!errorState && !authRequired}
          />
          <span className={cn(labelClass, "text-xs text-muted-foreground")}>{status}</span>
        </div>
      </div>
    </aside>
  )
}
