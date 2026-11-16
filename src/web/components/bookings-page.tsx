"use client"

import { useState } from "react"
import { AnimatePresence, motion } from "motion/react"

import { AnimateIcon, CalendarDays, RefreshCw } from "@/ui/icons"
import { Button } from "@/ui/button"
import { toastManager } from "@/ui/toast"
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableHoverActions,
  DataTableRevealCell,
  DataTableRow,
  PRESS_CLASS,
  SNAPPY,
} from "./data-table"
import { PageHeader, PageShell, PageState, RISE_CLASS } from "./page-layout"
import { cn } from "@/lib/utils"
import type { Booking, BookingAction } from "../../shared/types"
import { useBookingAction, useBookings } from "../data/queries"
import { useRefreshSignal } from "../data/store"
import { NoData } from "../shared"

const COLUMNS = "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(9rem,auto)]"

// 顺序即按钮渲染顺序；签到是唯一的主操作
const ACTIONS = [
  { key: "checkin", label: "签到", available: (b: Booking) => b.canCheckIn, primary: true },
  { key: "cancel", label: "取消", available: (b: Booking) => b.canCancel },
  { key: "leave", label: "暂离", available: (b: Booking) => b.canLeave },
  { key: "comeback", label: "续座", available: (b: Booking) => b.canRenew },
  { key: "signout", label: "签退", available: (b: Booking) => b.canSignOut },
] as const satisfies ReadonlyArray<{
  key: BookingAction
  label: string
  available: (b: Booking) => boolean
  primary?: true
}>

type Tone = "attention" | "active" | "idle"
type PendingAction = { id: string; action: BookingAction }

const toneOf = (booking: Booking): Tone =>
  booking.canCheckIn ? "attention" : booking.state === "in_use" ? "active" : "idle"

export function BookingsPage() {
  const bookings = useBookings()
  const action = useBookingAction()

  // ⌘K 面板 / `r` 快捷键请求刷新时重拉预约
  useRefreshSignal(() => void bookings.refetch())

  async function run(booking: Booking, name: BookingAction) {
    try {
      await action.mutateAsync({ id: booking.bookingId, action: name })
      toastManager.add({ type: "success", title: "预约操作成功" })
    } catch (cause) {
      toastManager.add({ type: "error", title: cause instanceof Error ? cause.message : "操作失败" })
    }
  }

  return (
    <PageState
      loading={bookings.isLoading}
      error={bookings.error}
      errorFallback="预约加载失败"
      onRetry={() => void bookings.refetch()}
    >
      <BookingsView
        key="ready"
        rows={bookings.data?.bookings ?? []}
        fetching={bookings.isFetching}
        busy={action.isPending}
        pending={action.isPending ? action.variables : undefined}
        onRefresh={() => void bookings.refetch()}
        onAction={(booking, name) => void run(booking, name)}
      />
    </PageState>
  )
}

function BookingsView({
  rows,
  fetching,
  busy,
  pending,
  onRefresh,
  onAction,
}: {
  rows: Booking[]
  fetching: boolean
  busy: boolean
  pending?: PendingAction
  onRefresh: () => void
  onAction: (booking: Booking, action: BookingAction) => void
}) {
  // 每次进入拉取状态就多转一圈，由弹簧自然停住，而不是匀速空转
  const [turns, setTurns] = useState(0)
  const [wasFetching, setWasFetching] = useState(fetching)
  if (fetching !== wasFetching) {
    setWasFetching(fetching)
    if (fetching) setTurns((t) => t + 1)
  }

  return (
    <PageShell>
      <PageHeader
        eyebrow="BOOKINGS"
        title="当前预约"
        actions={
          <AnimateIcon animateOnHover asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("font-medium text-foreground/80 hover:text-foreground", PRESS_CLASS)}
              disabled={fetching}
              onClick={onRefresh}
            >
              <span
                className="inline-flex transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                style={{ transform: `rotate(${turns * 360}deg)` }}
              >
                <RefreshCw className="size-3.5" />
              </span>
              刷新
            </Button>
          </AnimateIcon>
        }
      />

      <div className={cn("min-w-0", RISE_CLASS)}>
        <DataTable
          columns={COLUMNS}
          isEmpty={rows.length === 0}
          empty={<NoData icon={CalendarDays} title="暂无当前预约" />}
        >
          <DataTableHeader>
            <span>预约</span>
            <span>时间</span>
            <span>状态</span>
            <span className="text-right">操作</span>
          </DataTableHeader>
          <DataTableBody>
            {rows.map((booking, index) => (
              <BookingRow
                key={booking.bookingId}
                booking={booking}
                index={index}
                busy={busy}
                pending={pending}
                onAction={onAction}
              />
            ))}
          </DataTableBody>
        </DataTable>
      </div>
    </PageShell>
  )
}

function BookingRow({
  booking,
  index,
  busy,
  pending,
  onAction,
}: {
  booking: Booking
  index: number
  busy: boolean
  pending?: PendingAction
  onAction: (booking: Booking, action: BookingAction) => void
}) {
  const actions = ACTIONS.filter((a) => a.available(booking))
  const primaryActions = actions.filter((a) => "primary" in a)
  const secondaryActions = actions.filter((a) => !("primary" in a))
  const tone = toneOf(booking)

  const renderAction = (a: (typeof ACTIONS)[number], primary: boolean) => (
    <motion.div
      key={a.key}
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={SNAPPY}
    >
      <Button
        size="sm"
        variant={primary ? "default" : "ghost"}
        className={cn(
          primary ? undefined : "font-medium text-foreground/85 hover:text-foreground",
          PRESS_CLASS,
        )}
        disabled={busy}
        loading={pending?.id === booking.bookingId && pending.action === a.key}
        onClick={() => onAction(booking, a.key)}
      >
        {a.label}
      </Button>
    </motion.div>
  )

  return (
    <DataTableRow value={booking.bookingId} index={index} active={tone !== "idle"}>
      <DataTableRevealCell
        primary={<p className="truncate text-sm font-medium text-foreground">{booking.roomName}</p>}
        reveal={
          <p className="truncate">
            座位 <span className="font-medium text-foreground">{booking.seatNum}</span>
          </p>
        }
      />

      <DataTableRevealCell
        primary={<p className="truncate text-sm tabular-nums text-foreground">{booking.startText}</p>}
        reveal={<p className="truncate tabular-nums">时长 {booking.durationText}</p>}
      />

      <Status tone={tone} label={booking.statusLabel} />

      <motion.div layout className="relative flex flex-wrap items-center gap-1.5 sm:justify-end">
        {secondaryActions.length > 0 && (
          <DataTableHoverActions>
            <AnimatePresence mode="popLayout" initial={false}>
              {secondaryActions.map((a) => renderAction(a, false))}
            </AnimatePresence>
          </DataTableHoverActions>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {primaryActions.map((a) => renderAction(a, true))}
        </AnimatePresence>
      </motion.div>
    </DataTableRow>
  )
}

function Status({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2 text-sm text-foreground transition-opacity duration-150",
        tone === "idle" ? "opacity-80" : "opacity-100",
      )}
    >
      <span className="relative size-1.5 shrink-0">
        {tone === "attention" && (
          <span aria-hidden className="animate-status-halo absolute inset-0 rounded-full bg-foreground" />
        )}
        <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-muted-foreground/60" />
        <span
          className={cn(
            "absolute inset-0 rounded-full bg-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
            tone === "idle" ? "scale-0" : "scale-100",
          )}
        />
      </span>
      <span key={label} className="animate-tick-in inline-grid">
        {label}
      </span>
    </span>
  )
}
