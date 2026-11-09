"use client"

import { useState, type ReactNode, type Ref } from "react"
import { IconCalendarEvent, IconRefresh } from "@tabler/icons-react"
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from "motion/react"

import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import { PageHeader, PageShell, Panel } from "./page-layout"
import type { Booking } from "../../shared/types"
import { useBookingAction, useBookings } from "../queries"
import { useRefreshSignal } from "../store"
import { Busy, Failure, NoData } from "../shared"

// 弹簧预设：交互反馈要跟手（轻微回弹），布局位移要稳。
const SNAPPY = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } satisfies Transition
const SMOOTH = { type: "spring", stiffness: 320, damping: 32, mass: 0.9 } satisfies Transition
const SETTLE = { type: "spring", stiffness: 90, damping: 16 } satisfies Transition

const COLUMNS = "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(9rem,auto)]"

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

const press = {
  whileHover: { y: -1 },
  whileFocus: { y: -1 },
  whileTap: { scale: 0.96, y: 0 },
  transition: SNAPPY,
}

const row: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: (index: number) => ({
    opacity: 1,
    y: 0,
    transition: { ...SMOOTH, delay: Math.min(index, 6) * 0.035 },
  }),
  exit: { opacity: 0, scale: 0.98, transition: SNAPPY },
}

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

  const phase = bookings.isLoading ? "loading" : bookings.error ? "error" : "ready"

  return (
    <MotionConfig reducedMotion="user" transition={SMOOTH}>
      <AnimatePresence mode="wait">
        {phase === "loading" ? (
          <Fade key="loading">
            <Busy />
          </Fade>
        ) : phase === "error" ? (
          <Fade key="error">
            <Failure
              message={bookings.error instanceof Error ? bookings.error.message : "预约加载失败"}
              retry={() => void bookings.refetch()}
            />
          </Fade>
        ) : (
          <BookingsView
            key="ready"
            rows={bookings.data?.bookings ?? []}
            fetching={bookings.isFetching}
            busy={action.isPending}
            pending={action.isPending ? action.variables : undefined}
            onRefresh={() => void bookings.refetch()}
            onAction={(booking, name) => void run(booking, name)}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
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
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)

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
            className="text-muted-foreground hover:text-foreground"
            disabled={fetching}
            onClick={onRefresh}
            render={<motion.button type="button" {...press} />}
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

      <Panel title="有效预约">
        <AnimatePresence mode="popLayout" initial={false}>
          {rows.length ? (
            <motion.div
              key="list"
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="overflow-hidden rounded-xl border bg-card shadow-xs/5"
            >
              <motion.div
                layout="position"
                className={cn(
                  "hidden gap-6 border-b px-4 py-2.5 text-xs text-muted-foreground sm:grid",
                  COLUMNS,
                )}
              >
                <span>预约</span>
                <span>时间</span>
                <span>状态</span>
                <span className="text-right">操作</span>
              </motion.div>
              <LayoutGroup id="booking-rows">
                <ul
                  className="relative divide-y"
                  onPointerLeave={() => setHoveredRow(null)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setHoveredRow(null)
                  }}
                >
                  <AnimatePresence mode="popLayout">
                    {rows.map((booking, index) => (
                      <Row
                        key={booking.bookingId}
                        booking={booking}
                        index={index}
                        highlighted={hoveredRow === booking.bookingId}
                        busy={busy}
                        pending={pending}
                        onHighlight={() => setHoveredRow(booking.bookingId)}
                        onAction={onAction}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              </LayoutGroup>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              layout="position"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
            >
              <NoData icon={IconCalendarEvent} title="暂无当前预约" />
            </motion.div>
          )}
        </AnimatePresence>
      </Panel>
    </PageShell>
  )
}

function Row({
  ref,
  booking,
  index,
  highlighted,
  busy,
  pending,
  onHighlight,
  onAction,
}: {
  ref?: Ref<HTMLLIElement>
  booking: Booking
  index: number
  highlighted: boolean
  busy: boolean
  pending?: PendingAction
  onHighlight: () => void
  onAction: (booking: Booking, action: string) => void
}) {
  const actions = ACTIONS.filter((a) => a.available(booking))

  return (
    <motion.li
      ref={ref}
      layout
      custom={index}
      variants={row}
      initial="hidden"
      animate="show"
      exit="exit"
      className={cn("relative isolate grid gap-3 px-4 py-3.5 sm:items-center sm:gap-6", COLUMNS)}
      onPointerEnter={onHighlight}
      onFocus={onHighlight}
    >
      <Highlight id="row-highlight" active={highlighted} />

      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{booking.roomName}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          座位 <span className="font-sans text-foreground/80">{booking.seatNum}</span>
        </p>
      </div>

      <div className="min-w-0 text-sm">
        <p className="truncate tabular-nums">{booking.startText}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{booking.durationText}</p>
      </div>

      <Status tone={toneOf(booking)} label={booking.statusLabel} />

      <motion.div layout className="relative flex flex-wrap gap-1.5 sm:justify-end">
        <AnimatePresence mode="popLayout" initial={false}>
          {actions.map((a) => (
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
                variant={"primary" in a ? "default" : "ghost"}
                className={"primary" in a ? undefined : "text-muted-foreground hover:text-foreground"}
                disabled={busy}
                loading={pending?.id === booking.bookingId && pending.action === a.key}
                onClick={() => onAction(booking, a.key)}
                render={<motion.button type="button" {...press} />}
              >
                {a.label}
              </Button>
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    </motion.li>
  )
}

function Status({ tone, label }: { tone: Tone; label: string }) {
  const reduced = useReducedMotion()

  return (
    <motion.span
      className="inline-flex items-center gap-2 text-sm text-foreground"
      initial={false}
      animate={{ opacity: tone === "idle" ? 0.6 : 1 }}
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

// 共享 layoutId 的悬停底色：在同组单元之间滑动，离开时淡出
function Highlight({ id, active }: { id: string; active: boolean }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.span
          layoutId={id}
          aria-hidden
          className="absolute inset-0 -z-10 bg-muted/60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={SNAPPY}
        />
      )}
    </AnimatePresence>
  )
}

function Fade({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: SNAPPY }}
    >
      {children}
    </motion.div>
  )
}
