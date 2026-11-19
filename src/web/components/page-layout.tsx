"use client"

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { AnimatedShinyText } from "@/ui/animated-shiny-text"
import { Badge } from "@/ui/badge"
import { BlurFade } from "@/ui/blur-fade"
import { BlurText } from "@/ui/blur-text"
import { NumberTicker } from "@/ui/number-ticker"
import { Busy, Failure } from "../shared"

/** 区块错峰入场样式：配合 PageShell 的页头 0ms、主体 50ms 节奏。 */
export const RISE_CLASS = "animate-enter-rise [--enter-y:10px] [--enter-delay:50ms]"

/**
 * 页面加载态包装：统一加载 / 失败 / 就绪态之间的轻量 BlurFade 过渡。
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
      <BlurFade key="loading" duration={0.22} offset={6} blur="3px">
        <Busy />
      </BlurFade>
    )
  }

  if (phase === "error") {
    return (
      <BlurFade key="error" duration={0.22} offset={6} blur="3px">
        <Failure message={message} retry={onRetry} />
      </BlurFade>
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

/** 页头：眉题（AnimatedShinyText）+ 标题（BlurText）+ 可选计数徽章（NumberTicker），右侧放页面级动作。 */
export function PageHeader({
  eyebrow,
  title,
  count,
  actions,
}: {
  eyebrow?: string
  title: string
  count?: number
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="font-mono text-xs font-normal tracking-widest">
            <AnimatedShinyText shimmerWidth={80}>{eyebrow}</AnimatedShinyText>
          </p>
        ) : null}
        <div className={cn("flex items-center gap-2.5", eyebrow && "mt-1.5")}>
          <BlurText
            as="h1"
            text={title}
            delay={26}
            stepDuration={0.2}
            className="text-3xl font-semibold tracking-tight"
          />
          {count !== undefined && count > 0 ? (
            <Badge variant="outline" size="sm" className="mt-0.5 font-mono tabular-nums">
              <NumberTicker value={count} />
            </Badge>
          ) : null}
        </div>
      </div>
      {actions ? (
        <BlurFade
          duration={0.24}
          delay={0.04}
          offset={6}
          blur="3px"
          className="flex flex-wrap items-center gap-2"
        >
          {actions}
        </BlurFade>
      ) : null}
    </header>
  )
}
