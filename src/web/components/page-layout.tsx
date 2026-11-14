"use client"

import type { ReactNode } from "react"
import { AnimatePresence, MotionConfig, motion, type Variants } from "motion/react"

import { cn } from "@/lib/utils"
import { Busy, Failure } from "../shared"
import { SMOOTH, SNAPPY } from "./data-table"

/** 页面级动效：两页共用同一套节奏（子项错峰 50ms）。 */
const page: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}

/** 区块入场：配合 PageShell 的 stagger 使用。 */
export const rise: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
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

/**
 * 页面加载态包装：统一两页在加载 / 失败 / 就绪态之间的弹簧过渡。
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

  return (
    <MotionConfig reducedMotion="user" transition={SMOOTH}>
      <AnimatePresence mode="wait">
        {phase === "loading" ? (
          <Fade key="loading">
            <Busy />
          </Fade>
        ) : phase === "error" ? (
          <Fade key="error">
            <Failure message={message} retry={onRetry} />
          </Fade>
        ) : (
          children
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}

/**
 * 页面骨架。
 *
 * 预约方案 / 当前预约共用：统一的页间距与入场节奏，
 * 避免两个页面各写一套 padding、字号和动画。
 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={cn("flex min-w-0 flex-col gap-5", className)}
      variants={page}
      initial="hidden"
      animate="show"
    >
      {children}
    </motion.div>
  )
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
    <motion.header variants={rise} className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="font-sans text-xs font-normal tracking-widest text-muted-foreground">{eyebrow}</p>
        ) : null}
        <h1 className={cn("text-3xl font-semibold tracking-tight", eyebrow && "mt-1.5")}>{title}</h1>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </motion.header>
  )
}
