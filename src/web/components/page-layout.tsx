"use client"

import type { ReactNode } from "react"
import { motion, type Variants } from "motion/react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/** 页面级动效：两页共用同一套节奏（子项错峰 60ms）。 */
const page: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
}

/** 区块入场：配合 PageShell 的 stagger 使用。 */
export const rise: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
}

/**
 * 页面骨架。
 *
 * 预约方案 / 当前预约共用：统一的页间距（gap-6）与入场节奏，
 * 避免两个页面各写一套 padding、字号和动画。
 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={cn("flex min-w-0 flex-col gap-6", className)}
      variants={page}
      initial="hidden"
      animate="show"
    >
      {children}
    </motion.div>
  )
}

/** 页头：标题 + 说明 + 可选提示行，右侧放页面级动作。 */
export function PageHeader({
  eyebrow,
  title,
  description,
  hint,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: string
  hint?: ReactNode
  actions?: ReactNode
}) {
  return (
    <motion.header variants={rise} className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="font-serif text-xs font-normal tracking-widest text-muted-foreground">{eyebrow}</p>
        ) : null}
        <h1 className={cn("text-3xl font-semibold tracking-tight", eyebrow && "mt-2")}>{title}</h1>
        {description ? <p className="mt-1.5 text-sm text-muted-foreground">{description}</p> : null}
        {hint}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </motion.header>
  )
}

/**
 * 内容面板：标题 + 说明 + 内容区，两侧页面统一用同一个 Card。
 * `contentClassName` 用来去掉内边距（表格类内容需要贴边）。
 */
export function Panel({
  title,
  description,
  contentClassName,
  children,
}: {
  title: string
  description?: string
  contentClassName?: string
  children: ReactNode
}) {
  return (
    <motion.div variants={rise} className="min-w-0">
      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className={cn("min-w-0", contentClassName)}>{children}</CardContent>
      </Card>
    </motion.div>
  )
}
