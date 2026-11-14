"use client"

import { useState } from "react"
import { IconCalendarEvent, IconRefresh } from "@tabler/icons-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Button } from "@/ui/button"
import { toastManager } from "@/ui/toast"
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableHoverActions,
  DataTableRevealCell,
  DataTableRow,
  PRESS,
  SETTLE,
  SNAPPY,
} from "./data-table"
import { PageHeader, PageShell, PageState, rise } from "./page-layout"
import type { Booking } from "../../shared/types"
import { useBookingAction, useBookings } from "../data/queries"
import { useRefreshSignal } from "../data/store"
import { NoData } from "../shared"

const COLUMNS = "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(9rem,auto)]"

// 顺序即按钮渲染顺序；签到是唯一的主操作
const ACTIONS = [
  { key: "check-in", label: "签到", available: (b: Booking) => b.canCheckIn, primary: true },
  { key: "cancel", label: "取消", available: (b: Booking) => b.canCancel },
  { key: "leave", label: "暂离", available: (b: Booking) => b.canLeave },
  { key: "renew", label: "续座", available: (b: Booking) => b.canRenew },
  { key: "sign-out", label: "签退", available: (b: Booking) => b.canSignOut },
] as const

type Tone = "attention" | "active" | "idle"
type PendingAction = { id: string; action: string }

const toneOf = (booking: Booking): Tone =>
  booking.canCheckIn ? "attention" : booking.state === "in_use" ? "active" : "idle"

export function BookingsPage() {
  const bookings = useBookings()
  const action = useBookingAction()

  // ⌘K 面板 / `r` 快捷键请求刷新时重拉预约
  useRefreshSignal(() => void bookings.refetch())

  async function run(booking: Booking, name: string) {
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
  onAction: (booking: Booking, action: string) => void
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
          <Button
            variant="ghost"
            size="sm"
            className="font-medium text-foreground/80 hover:text-foreground"
            disabled={fetching}
            onClick={onRefresh}
            render={<motion.button type="button" {...PRESS} />}
          >
            <motion.span
              className="inline-flex"
              initial={false}
              animate={{ rotate: turns * 360 }}
              transition={SETTLE}
            >
              <IconRefresh className="size-3.5" />
            </motion.span>
            刷新
          </Button>
        }
      />

      <motion.div variants={rise} className="min-w-0">
        <DataTable
          columns={COLUMNS}
          isEmpty={rows.length === 0}
          empty={<NoData icon={IconCalendarEvent} title="暂无当前预约" />}
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
      </motion.div>
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
  onAction: (booking: Booking, action: string) => void
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
        className={primary ? undefined : "font-medium text-foreground/85 hover:text-foreground"}
        disabled={busy}
        loading={pending?.id === booking.bookingId && pending.action === a.key}
        onClick={() => onAction(booking, a.key)}
        render={<motion.button type="button" {...PRESS} />}
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
  const reduced = useReducedMotion()

  return (
    <motion.span
      className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground"
      initial={false}
      animate={{ opacity: tone === "idle" ? 0.8 : 1 }}
    >
      <span className="relative size-1.5 shrink-0">
        <AnimatePresence>
          {tone === "attention" && !reduced && (
            <motion.span
              key="halo"
              aria-hidden
              className="absolute inset-0 rounded-full bg-foreground"
              initial={{ scale: 1, opacity: 0 }}
              animate={{ scale: [1, 3], opacity: [0.45, 0] }}
              exit={{ opacity: 0, transition: SNAPPY }}
              transition={{
                type: "spring",
                visualDuration: 1.2,
                bounce: 0,
                repeat: Infinity,
                repeatDelay: 0.5,
              }}
            />
          )}
        </AnimatePresence>
        <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-muted-foreground/60" />
        <motion.span
          className="absolute inset-0 rounded-full bg-foreground"
          initial={false}
          animate={{ scale: tone === "idle" ? 0 : 1 }}
          transition={SNAPPY}
        />
      </span>
      <span className="relative inline-grid">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={SNAPPY}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
    </motion.span>
  )
}
