"use client"

import { useState } from "react"
import { AnimatePresence, motion } from "motion/react"

import { AnimateIcon, CalendarDays, RefreshCw } from "@/ui/icons"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/ui/alert-dialog"
import { BlurFade } from "@/ui/blur-fade"
import { Button } from "@/ui/button"
import { fireConfetti } from "@/ui/confetti"
import { ShimmerButton } from "@/ui/shimmer-button"
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
import { PageHeader, PageShell, PageState } from "./page-layout"
import { cn } from "@/lib/utils"
import type { Booking, BookingAction } from "../../shared/types"
import { useBookingAction, useBookings } from "../data/queries"
import { useRefreshSignal } from "../data/store"
import { NoData } from "../shared"

const COLUMNS = "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(9rem,auto)]"

// 顺序即按钮渲染顺序；签到是唯一的主操作
const ACTIONS = [
  {
    key: "checkin",
    label: "签到",
    successTitle: "签到成功",
    available: (b: Booking) => b.canCheckIn,
    primary: true,
  },
  {
    key: "cancel",
    label: "取消",
    successTitle: "预约已取消",
    available: (b: Booking) => b.canCancel,
    confirm: {
      title: "取消这条预约？",
      description: (b: Booking) => `将取消 ${b.roomName}（座位 ${b.seatNum}）的预约，座位会立即释放。`,
      actionLabel: "确认取消",
    },
  },
  { key: "leave", label: "暂离", successTitle: "已设为暂离", available: (b: Booking) => b.canLeave },
  { key: "comeback", label: "续座", successTitle: "续座成功", available: (b: Booking) => b.canRenew },
  {
    key: "signout",
    label: "签退",
    successTitle: "签退成功",
    available: (b: Booking) => b.canSignOut,
    confirm: {
      title: "确认签退？",
      description: (b: Booking) =>
        `将结束 ${b.roomName}（座位 ${b.seatNum}）的本次使用并释放座位，此操作无法撤销。`,
      actionLabel: "确认签退",
    },
  },
] as const satisfies ReadonlyArray<{
  key: BookingAction
  label: string
  successTitle: string
  available: (b: Booking) => boolean
  primary?: true
  confirm?: {
    title: string
    description: (b: Booking) => string
    actionLabel: string
  }
}>

type ActionConfig = (typeof ACTIONS)[number]
type Tone = "attention" | "active" | "idle"
type PendingAction = { id: string; action: BookingAction }
type ConfirmTarget = { booking: Booking; action: Extract<ActionConfig, { confirm: object }> }

const toneOf = (booking: Booking): Tone =>
  booking.canCheckIn ? "attention" : booking.state === "in_use" ? "active" : "idle"

export function BookingsPage() {
  const bookings = useBookings()
  const action = useBookingAction()
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null)

  // ⌘K 面板 / `r` 快捷键请求刷新时重拉预约
  useRefreshSignal(() => void bookings.refetch())

  async function run(booking: Booking, config: ActionConfig, trigger?: Element | null) {
    try {
      await action.mutateAsync({ id: booking.bookingId, action: config.key })
      if (config.key === "checkin") fireConfetti(trigger)
      toastManager.add({ type: "success", title: config.successTitle })
      return true
    } catch (cause) {
      toastManager.add({ type: "error", title: cause instanceof Error ? cause.message : "操作失败" })
      return false
    }
  }

  function handleAction(booking: Booking, config: ActionConfig, trigger?: Element | null) {
    if ("confirm" in config) {
      setConfirmTarget({ booking, action: config })
      return
    }
    void run(booking, config, trigger)
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
        pending={action.isPending ? action.variables : undefined}
        onRefresh={() => void bookings.refetch()}
        onAction={handleAction}
      />

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open && !action.isPending) setConfirmTarget(null)
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTarget?.action.confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget ? confirmTarget.action.confirm.description(confirmTarget.booking) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={action.isPending} />}>
              返回
            </AlertDialogClose>
            <Button
              variant="destructive"
              loading={action.isPending}
              onClick={async () => {
                if (!confirmTarget) return
                const ok = await run(confirmTarget.booking, confirmTarget.action)
                if (ok) setConfirmTarget(null)
              }}
            >
              {confirmTarget?.action.confirm.actionLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </PageState>
  )
}

function BookingsView({
  rows,
  fetching,
  pending,
  onRefresh,
  onAction,
}: {
  rows: Booking[]
  fetching: boolean
  pending?: PendingAction
  onRefresh: () => void
  onAction: (booking: Booking, action: ActionConfig, trigger?: Element | null) => void
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
        count={rows.length}
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

      <BlurFade delay={0.05} duration={0.28} offset={10} blur="4px" className="min-w-0">
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
                pending={pending}
                onAction={onAction}
              />
            ))}
          </DataTableBody>
        </DataTable>
      </BlurFade>
    </PageShell>
  )
}

function BookingRow({
  booking,
  index,
  pending,
  onAction,
}: {
  booking: Booking
  index: number
  pending?: PendingAction
  onAction: (booking: Booking, action: ActionConfig, trigger?: Element | null) => void
}) {
  const actions = ACTIONS.filter((a) => a.available(booking))
  const primaryActions = actions.filter((a) => "primary" in a)
  const secondaryActions = actions.filter((a) => !("primary" in a))
  const tone = toneOf(booking)
  const rowBusy = pending?.id === booking.bookingId

  const renderAction = (a: ActionConfig, primary: boolean) => {
    const isPending = rowBusy && pending?.action === a.key
    return (
      <motion.div
        key={a.key}
        layout
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={SNAPPY}
      >
        {primary ? (
          <ShimmerButton
            className="h-8 px-3 py-1 text-xs"
            disabled={rowBusy}
            loading={isPending}
            onClick={(event) => onAction(booking, a, event.currentTarget)}
          >
            {a.label}
          </ShimmerButton>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "font-medium text-foreground/85 hover:text-foreground",
              "confirm" in a && "hover:text-destructive",
              PRESS_CLASS,
            )}
            disabled={rowBusy}
            loading={isPending}
            onClick={(event) => onAction(booking, a, event.currentTarget)}
          >
            {a.label}
          </Button>
        )}
      </motion.div>
    )
  }

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
