"use client"

import { RefreshCw, CalendarDays, CheckCircle2, Clock } from "lucide-react"
import { useReducedMotion } from "motion/react"

import { AnimatedShinyText } from "@/components/ui/animated-shiny-text"
import { Badge } from "@/components/ui/badge"
import { BlurFade } from "@/components/ui/blur-fade"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MagicCard } from "@/components/ui/magic-card"
import { NumberTicker } from "@/components/ui/number-ticker"
import { toastManager } from "@/components/ui/toast"
import type { Booking } from "../../shared/types"
import { useBookingAction, useBookings } from "../queries"
import { Busy, Failure, NoData } from "../shared"

export function BookingsPage() {
  const bookings = useBookings()
  const action = useBookingAction()
  const reduced = useReducedMotion()
  async function run(booking: Booking, name: string) {
    try {
      await action.mutateAsync({ id: booking.bookingId, action: name })
      toastManager.add({ type: "success", title: "预约操作成功" })
    } catch (cause) {
      toastManager.add({ type: "error", title: cause instanceof Error ? cause.message : "操作失败" })
    }
  }

  if (bookings.isLoading) return <Busy />
  if (bookings.error)
    return (
      <Failure
        message={bookings.error instanceof Error ? bookings.error.message : "预约加载失败"}
        retry={() => void bookings.refetch()}
      />
    )

  const rows = bookings.data?.bookings ?? []
  const checkInCount = rows.filter((booking) => booking.canCheckIn).length
  const inUseCount = rows.filter((booking) => booking.state === "in_use").length

  return (
    <div className="grid gap-6">
      <BlurFade className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-widest text-muted-foreground">
            LIVE STATUS
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">当前预约</h1>
          <AnimatedShinyText className="mt-1 block max-w-none text-sm">
            实时查看预约生命周期，并执行可用操作。
          </AnimatedShinyText>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void bookings.refetch()}>
            <RefreshCw className={bookings.isFetching ? "animate-spin" : ""} />
            刷新
          </Button>
        </div>
      </BlurFade>

      <div className="grid gap-3 sm:grid-cols-3">
        <BlurFade>
          <MagicCard className="h-full rounded-2xl border bg-card p-4 shadow-sm" gradientOpacity={0.08}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">可签到</p>
                <p className="mt-2 text-2xl font-semibold tracking-tight">
                  {reduced ? checkInCount : <NumberTicker value={checkInCount} className="text-foreground" />}
                </p>
              </div>
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
                <CheckCircle2 className="size-4" />
              </span>
            </div>
          </MagicCard>
        </BlurFade>
        <BlurFade delay={0.04}>
          <MagicCard className="h-full rounded-2xl border bg-card p-4 shadow-sm" gradientOpacity={0.08}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">使用中</p>
                <p className="mt-2 text-2xl font-semibold tracking-tight">
                  {reduced ? inUseCount : <NumberTicker value={inUseCount} className="text-foreground" />}
                </p>
              </div>
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
                <Clock className="size-4" />
              </span>
            </div>
          </MagicCard>
        </BlurFade>
        <BlurFade delay={0.08}>
          <MagicCard className="h-full rounded-2xl border bg-card p-4 shadow-sm" gradientOpacity={0.08}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">全部预约</p>
                <p className="mt-2 text-2xl font-semibold tracking-tight">
                  {reduced ? rows.length : <NumberTicker value={rows.length} className="text-foreground" />}
                </p>
              </div>
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
                <CalendarDays className="size-4" />
              </span>
            </div>
          </MagicCard>
        </BlurFade>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>有效预约</CardTitle>
          <CardDescription>后台会自动处理进入签到窗口的预约。</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length ? (
            <Table variant="card">
              <TableHeader>
                <TableRow>
                  <TableHead>预约</TableHead>
                  <TableHead>时间</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((booking) => (
                  <TableRow key={booking.bookingId} className="relative">
                    <TableCell>
                      <strong>
                        {booking.roomName} · 座位 {booking.seatNum}
                      </strong>
                    </TableCell>
                    <TableCell>
                      {booking.startText} · {booking.durationText}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          booking.canCheckIn
                            ? "warning"
                            : booking.state === "in_use"
                              ? "success"
                              : "secondary"
                        }
                      >
                        {booking.statusLabel}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        {booking.canCheckIn && (
                          <Button size="sm" loading={action.isPending} onClick={() => void run(booking, "check-in")}>
                            签到
                          </Button>
                        )}
                        {booking.canCancel && (
                          <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => void run(booking, "cancel")}>
                            取消
                          </Button>
                        )}
                        {booking.canLeave && (
                          <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => void run(booking, "leave")}>
                            暂离
                          </Button>
                        )}
                        {booking.canRenew && (
                          <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => void run(booking, "renew")}>
                            续座
                          </Button>
                        )}
                        {booking.canSignOut && (
                          <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => void run(booking, "sign-out")}>
                            签退
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <NoData icon={CalendarDays} title="暂无当前预约" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
