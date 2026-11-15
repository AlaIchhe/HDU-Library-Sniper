"use client"

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Busy, Failure } from "../shared"

/** 区块错峰入场样式：配合 PageShell 的页头 0ms、主体 50ms 节奏。 */
export const RISE_CLASS = "animate-enter-rise [--enter-y:10px] [--enter-delay:50ms]"

/**
 * 页面加载态包装：统一加载 / 失败 / 就绪态之间的轻量 CSS 入场过渡。
 */
export function PageState({
  loading,
  error,
  errorFallback,
  onRetry,
  children,
}: {
  loading: boolean
  error: unknown
  errorFallback: string
  onRetry: () => void
  children: ReactNode
}) {
  const phase = loading ? "loading" : error ? "error" : "ready"
  const message = error instanceof Error ? error.message : errorFallback

  if (phase === "loading") {
    return (
      <div key="loading" className="animate-enter-rise [--enter-y:6px]">
        <Busy />
      </div>
    )
  }

  if (phase === "error") {
    return (
      <div key="error" className="animate-enter-rise [--enter-y:6px]">
        <Failure message={message} retry={onRetry} />
      </div>
    )
  }

  return <>{children}</>
}

/**
 * 页面骨架。
 *
 * 预约方案 / 当前预约共用：统一的页间距与入场节奏，
 * 避免两个页面各写一套 padding、字号和动画。
 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-w-0 flex-col gap-5", className)}>{children}</div>
}

/** 页头：标题 + 眉题，右侧放页面级动作。 */
export function PageHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow?: string
  title: string
  actions?: ReactNode
}) {
  return (
    <header className="animate-enter-rise flex flex-wrap items-end justify-between gap-3 [--enter-y:10px]">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="font-sans text-xs font-normal tracking-widest text-muted-foreground">{eyebrow}</p>
        ) : null}
        <h1 className={cn("text-3xl font-semibold tracking-tight", eyebrow && "mt-1.5")}>{title}</h1>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
