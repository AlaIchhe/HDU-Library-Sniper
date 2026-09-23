"use client"

import { useEffect, useState, type ReactNode, type Ref } from "react"
import { CalendarDays, RefreshCw } from "lucide-react"
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
  type Transition,
  type Variants,
} from "motion/react"

import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type { Booking } from "../../shared/types"
import { useBookingAction, useBookings } from "../queries"
import { Busy, Failure, NoData } from "../shared"

// 弹簧预设：交互反馈要跟手（轻微回弹），布局位移要稳，数字滚动临界阻尼（取整后不能过冲）
const SNAPPY = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } satisfies Transition
const SMOOTH = { type: "spring", stiffness: 320, damping: 32, mass: 0.9 } satisfies Transition
const SETTLE = { type: "spring", stiffness: 90, damping: 16 } satisfies Transition
const COUNT = { stiffness: 140, damping: 24, mass: 1 }

// layout 动画需要 px 圆角，motion 才能在缩放时做圆角校正
const RADIUS = 18

const COLUMNS =
  "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(9rem,auto)]"

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

const page: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
  exit: { opacity: 0, transition: SNAPPY },
}

const rise: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
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
  const [hoveredStat, setHoveredStat] = useState<string | null>(null)
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)

  // 每次进入拉取状态就多转一圈，由弹簧自然停住，而不是匀速空转
  const [turns, setTurns] = useState(0)
  const [wasFetching, setWasFetching] = useState(fetching)
  if (fetching !== wasFetching) {
    setWasFetching(fetching)
    if (fetching) setTurns((t) => t + 1)
  }

  const stats = [
    { label: "可签到", value: rows.filter((b) => b.canCheckIn).length },
    { label: "使用中", value: rows.filter((b) => b.state === "in_use").length },
    { label: "全部预约", value: rows.length },
  ]

  return (
    <motion.div
      className="flex flex-col gap-10"
      variants={page}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <motion.header variants={rise} className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">当前预约</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            实时查看预约生命周期，并执行可用操作。
          </p>
        </div>
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
            <RefreshCw className="size-3.5" />
          </motion.span>
          刷新
        </Button>
      </motion.header>

      <LayoutGroup id="booking-stats">
        <motion.dl
          variants={rise}
          style={{ borderRadius: RADIUS }}
          className="grid grid-cols-3 divide-x overflow-hidden border bg-card"
          onPointerLeave={() => setHoveredStat(null)}
        >
          {stats.map(({ label, value }) => (
            <div
              key={label}
              className="relative isolate px-5 py-4"
              onPointerEnter={() => setHoveredStat(label)}
            >
              <Highlight id="stat-highlight" active={hoveredStat === label} />
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <motion.dd
                className="mt-2 text-2xl font-semibold tabular-nums tracking-tight"
                initial={false}
                animate={{ opacity: value === 0 ? 0.4 : 1 }}
              >
                <Count value={value} />
              </motion.dd>
            </div>
          ))}
        </motion.dl>
      </LayoutGroup>

      <motion.section variants={rise} className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium">有效预约</h2>
          <p className="text-xs text-muted-foreground">后台会自动处理进入签到窗口的预约。</p>
        </div>

        <motion.div
          layout
          style={{ borderRadius: RADIUS }}
          className="relative overflow-hidden border bg-card"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {rows.length ? (
              <motion.div
                key="list"
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <motion.div
                  layout="position"
                  className={cn(
                    "hidden gap-6 border-b px-5 py-2.5 text-xs text-muted-foreground sm:grid",
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
                <NoData icon={CalendarDays} title="暂无当前预约" />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.section>
    </motion.div>
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
      className={cn("relative isolate grid gap-3 px-5 py-4 sm:items-center sm:gap-6", COLUMNS)}
      onPointerEnter={onHighlight}
      onFocus={onHighlight}
    >
      <Highlight id="row-highlight" active={highlighted} />

      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{booking.roomName}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          座位 <span className="font-mono text-foreground/80">{booking.seatNum}</span>
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
              transition={{ type: "spring", visualDuration: 1.2, bounce: 0, repeat: Infinity, repeatDelay: 0.5 }}
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

function Count({ value }: { value: number }) {
  const reduced = useReducedMotion()
  const spring = useSpring(reduced ? value : 0, COUNT)
  const display = useTransform(spring, (v) => Math.round(v))

  useEffect(() => {
    if (reduced) spring.jump(value)
    else spring.set(value)
  }, [spring, value, reduced])

  return <motion.span>{display}</motion.span>
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
