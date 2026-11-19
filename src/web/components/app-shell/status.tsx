"use client"

import { useState } from "react"

import { Clock } from "@/ui/icons"

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/ui/alert-dialog"
import { BorderBeam } from "@/ui/border-beam"
import { Button } from "@/ui/button"
import { SlidingNumber } from "@/ui/sliding-number"
import { TextShimmer } from "@/ui/text-shimmer"
import { toastManager } from "@/ui/toast"
import { useCheckin, useCheckinMutation, useNextTarget } from "../../data/queries"
import { useCountdown } from "../../hooks/use-countdown"

/** 统一的语义色状态点：颜色由 tone 决定，脉冲使用 CSS 关键帧。 */
export function StatusDot({
  tone,
  pulse = false,
}: {
  tone: "ok" | "warn" | "bad" | "idle"
  pulse?: boolean
}) {
  const color = {
    ok: "bg-success",
    warn: "bg-warning",
    bad: "bg-destructive",
    idle: "bg-muted-foreground/50",
  }[tone]

  return (
    <span className="relative grid size-2 shrink-0 place-items-center">
      {pulse && tone !== "idle" && (
        <span aria-hidden className={`animate-status-halo absolute inset-0 rounded-full ${color}`} />
      )}
      <span className={`absolute inset-0 rounded-full transition-colors duration-200 ${color}`} />
    </span>
  )
}

function CountdownReadout({ remainingMs, expired }: { remainingMs: number; expired: boolean }) {
  if (expired) {
    return (
      <TextShimmer duration={1.8} className="font-medium">
        即将执行
      </TextShimmer>
    )
  }

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (days > 0) {
    return (
      <span className="inline-flex items-baseline gap-0.5 tabular-nums">
        <SlidingNumber value={days} />
        <span>天</span>
        <SlidingNumber value={hours} className="ms-0.5" />
        <span>小时</span>
      </span>
    )
  }
  if (hours > 0) {
    return (
      <span className="inline-flex items-baseline gap-0.5 tabular-nums">
        <SlidingNumber value={hours} />
        <span>小时</span>
        <SlidingNumber value={minutes} padStart className="ms-0.5" />
        <span>分</span>
      </span>
    )
  }
  if (minutes > 0) {
    return (
      <span className="inline-flex items-baseline gap-0.5 tabular-nums">
        <SlidingNumber value={minutes} />
        <span>分</span>
        <SlidingNumber value={seconds} padStart className="ms-0.5" />
        <span>秒</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-baseline gap-0.5 tabular-nums">
      <SlidingNumber value={seconds} />
      <span>秒</span>
    </span>
  )
}

/**
 * 顶栏状态区：一眼看清「后台在不在线、下一次什么时候动」。
 *
 * 倒计时只用本地 timer 重算，不发网络请求；数字使用 Motion Primitives SlidingNumber 滚轮过渡。
 */
export function StatusBar({ runtimeState }: { runtimeState: string | undefined }) {
  const target = useNextTarget()
  const countdown = useCountdown(target.data?.at)

  const tone: "ok" | "warn" | "bad" | "idle" =
    runtimeState === "error"
      ? "bad"
      : runtimeState === "auth_required"
        ? "warn"
        : runtimeState === "running"
          ? "ok"
          : target.data?.kind && target.data.kind !== "none"
            ? "ok"
            : "idle"

  const label = target.data?.label || "等待方案启用"
  const activeBeam = tone === "ok" && Boolean(target.data?.at || runtimeState === "running")

  return (
    <div className="relative flex min-w-0 items-center gap-2.5 overflow-hidden rounded-full border bg-card/70 py-1 ps-2.5 pe-3 text-xs shadow-xs/5 backdrop-blur">
      {activeBeam ? (
        <BorderBeam
          size={40}
          duration={9}
          borderWidth={1}
          colorFrom={runtimeState === "running" ? "var(--success)" : "var(--sheen-strong)"}
          colorTo="var(--sheen)"
        />
      ) : null}
      <StatusDot tone={tone} pulse={runtimeState === "running"} />

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-muted-foreground max-lg:hidden">下一次</span>
        <span
          className="max-w-[16rem] truncate font-medium text-foreground max-lg:max-w-[9rem]"
          title={label}
        >
          {label}
        </span>
      </div>

      {target.data?.at ? (
        <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-muted-foreground">
          <Clock className="size-3" animateOnHover />
          {countdown ? (
            <CountdownReadout remainingMs={countdown.remainingMs} expired={countdown.expired} />
          ) : (
            "…"
          )}
        </span>
      ) : null}
    </div>
  )
}

export function CheckinControl() {
  const { data, isLoading } = useCheckin()
  const mutation = useCheckinMutation()
  const [pending, setPending] = useState<boolean | null>(null)

  async function confirm() {
    if (pending === null) return
    try {
      await mutation.mutateAsync({ enabled: pending, agreed: pending })
      toastManager.add({
        type: "success",
        title: pending ? "自动签到已启用" : "自动签到已关闭",
      })
      setPending(null)
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "自动签到设置失败",
      })
    }
  }

  return (
    <>
      <Button
        variant={data?.enabled ? "secondary" : "ghost"}
        size="sm"
        disabled={isLoading || mutation.isPending}
        onClick={() => {
          if (data) setPending(!data.enabled)
        }}
        title={data?.enabled ? "自动签到已开启，点击关闭" : "自动签到已关闭，点击开启"}
      >
        <StatusDot tone={data?.enabled ? "ok" : "idle"} />
        <span className="max-sm:hidden">{data?.enabled ? "自动签到" : "未开签到"}</span>
      </Button>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setPending(null)
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? "启用自动签到？" : "关闭自动签到？"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? "自动签到会在服务端签到窗口内提交签到请求。继续启用吗？"
                : "关闭后不会再自动提交签到，已有预约仍可手动签到。确定关闭吗？"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={mutation.isPending} />}>
              取消
            </AlertDialogClose>
            <Button loading={mutation.isPending} onClick={() => void confirm()}>
              {pending ? "启用" : "关闭"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  )
}
