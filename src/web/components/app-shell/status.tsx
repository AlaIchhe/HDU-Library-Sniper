"use client"

import { useState } from "react"
import { IconClock } from "@tabler/icons-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/ui/alert-dialog"
import { Button } from "@/ui/button"
import { toastManager } from "@/ui/toast"
import { useCheckin, useCheckinMutation, useNextTarget } from "../../data/queries"
import { useCountdown } from "../../hooks/use-countdown"

/** 统一的语义色状态点：颜色由 tone 决定，切换时用 spring 过渡而非硬切。 */

export function StatusDot({
  tone,
  pulse = false,
}: {
  tone: "ok" | "warn" | "bad" | "idle"
  pulse?: boolean
}) {
  const reduced = useReducedMotion()
  const color = {
    ok: "bg-success",
    warn: "bg-warning",
    bad: "bg-destructive",
    idle: "bg-muted-foreground/50",
  }[tone]

  return (
    <span className="relative grid size-2 shrink-0 place-items-center">
      {pulse && tone !== "idle" && !reduced && (
        <motion.span
          aria-hidden
          className={`absolute inset-0 rounded-full ${color}`}
          initial={{ scale: 1, opacity: 0 }}
          animate={{ scale: [1, 2.6], opacity: [0.5, 0] }}
          transition={{
            type: "spring",
            visualDuration: 1.4,
            bounce: 0,
            repeat: Infinity,
            repeatDelay: 0.6,
          }}
        />
      )}
      <motion.span
        className={`absolute inset-0 rounded-full ${color}`}
        initial={false}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
      />
    </span>
  )
}

/**
 * 顶栏状态区：一眼看清「后台在不在线、下一次什么时候动」。
 *
 * 倒计时只用本地 timer 重算，不发网络请求。
 */
export function StatusBar({ runtimeState }: { runtimeState: string | undefined }) {
  const target = useNextTarget()
  const countdown = useCountdown(target.data?.at)
  const reduced = useReducedMotion()

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

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-full border bg-card/60 py-1 ps-2.5 pe-3 text-xs shadow-xs/5 backdrop-blur">
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

      <AnimatePresence mode="popLayout" initial={false}>
        {target.data?.at ? (
          <motion.span
            key={countdown?.text ?? "loading"}
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
            className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground"
          >
            <IconClock className="size-3" />
            {countdown?.text ?? "…"}
          </motion.span>
        ) : null}
      </AnimatePresence>
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
