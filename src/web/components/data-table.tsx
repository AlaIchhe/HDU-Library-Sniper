"use client"

import { AnimatePresence, motion, type Transition, type Variants } from "motion/react"
import { createContext, type ReactNode, type Ref, useContext } from "react"
import { cn } from "../../lib/utils"
import { GlowingEffect } from "../../ui/glowing-effect"
import { Highlight, HighlightItem } from "../../ui/highlight"

// 弹簧预设：交互反馈跟手、布局位移平稳，两页列表共享同一套物理节奏。
export const SNAPPY = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} satisfies Transition

const SMOOTH = {
  type: "spring",
  stiffness: 320,
  damping: 32,
  mass: 0.9,
} satisfies Transition

export const PRESS_CLASS =
  "transition-[box-shadow,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:-translate-y-px active:translate-y-0 active:scale-[0.96] motion-reduce:transition-none motion-reduce:transform-none"

const rowVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: (index: number) => ({
    opacity: 1,
    y: 0,
    transition: { ...SMOOTH, delay: Math.min(index, 8) * 0.035 },
  }),
  exit: { opacity: 0, scale: 0.985, transition: SNAPPY },
}

type DataTableContextValue = {
  columns: string
}

const DataTableContext = createContext<DataTableContextValue | null>(null)

function useDataTableContext() {
  const ctx = useContext(DataTableContext)
  if (!ctx) {
    throw new Error("DataTable subcomponents must be rendered inside <DataTable>")
  }
  return ctx
}

/**
 * 统一的数据列表容器（单层卡片表面 + Aceternity 单色 GlowingEffect 边框光弧 +
 * Animate UI Highlight 滑块高亮 + Hover-Reveal 渐进披露）。
 *
 * - 单层边框表面：直接承接 `PageHeader`，避免外层再套 Panel Card；
 * - 统一列模板：`columns` 同时作用于表头和行，保证网格对齐；
 * - 零横向溢出 & 无静态小灰字：常规状态只显示高对比主信息，次要细节与操作随鼠标/聚焦唤醒。
 */
export function DataTable({
  columns,
  isEmpty,
  empty,
  className,
  children,
}: {
  columns: string
  isEmpty: boolean
  empty: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <DataTableContext.Provider value={{ columns }}>
      <div className="relative min-w-0 rounded-2xl">
        <GlowingEffect spread={30} proximity={64} inactiveZone={0.6} borderWidth={1} />
        <motion.div
          layout="position"
          className={cn(
            "relative min-w-0 overflow-hidden rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {isEmpty ? (
              <motion.div
                key="empty"
                layout="position"
                initial={{ opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.985 }}
                transition={SNAPPY}
              >
                {empty}
              </motion.div>
            ) : (
              <motion.div
                key="list"
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="min-w-0"
              >
                {children}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </DataTableContext.Provider>
  )
}

export function DataTableHeader({ className, children }: { className?: string; children: ReactNode }) {
  const { columns } = useDataTableContext()

  return (
    <div
      className={cn(
        "hidden border-b bg-muted/35 px-4 py-3 text-[13px] font-medium text-foreground/75 sm:grid sm:items-center sm:gap-5 sm:px-5",
        columns,
        className,
      )}
    >
      {children}
    </div>
  )
}

export function DataTableBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Highlight
      mode="parent"
      hover
      controlledItems
      exitDelay={100}
      transition={SNAPPY}
      className="bg-muted/55"
      containerClassName="relative min-w-0"
    >
      <ul className={cn("relative z-1 divide-y divide-border/75", className)}>
        <AnimatePresence mode="popLayout" initial={false}>
          {children}
        </AnimatePresence>
      </ul>
    </Highlight>
  )
}

export function DataTableRow({
  ref,
  value,
  index,
  active = false,
  className,
  children,
}: {
  ref?: Ref<HTMLLIElement>
  value: string
  index: number
  active?: boolean
  className?: string
  children: ReactNode
}) {
  const { columns } = useDataTableContext()

  return (
    <HighlightItem value={value} asChild>
      <motion.li
        ref={ref}
        layout="position"
        custom={index}
        variants={rowVariants}
        initial="hidden"
        animate="show"
        exit="exit"
        className={cn(
          "group/row relative isolate grid min-w-0 gap-3 px-4 py-3.5 sm:min-h-[4.35rem] sm:items-center sm:gap-5 sm:px-5",
          columns,
          className,
        )}
      >
        <AnimatePresence>
          {active && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-y-4 left-1.5 w-[3px] rounded-full bg-primary"
              initial={{ opacity: 0, scaleY: 0.3 }}
              animate={{ opacity: 1, scaleY: 1 }}
              exit={{ opacity: 0, scaleY: 0.3 }}
              transition={SNAPPY}
            />
          )}
        </AnimatePresence>

        {children}
      </motion.li>
    </HighlightItem>
  )
}

/**
 * 渐进披露单元格：
 * - 桌面鼠标屏静默时仅垂直居中展示高对比主信息，不堆积灰色小字；
 * - 鼠标移入行或键盘聚焦时，主信息轻抬并在下方平滑揭示高对比补充信息，全程零行高跳动；
 * - 移动端与纯触屏设备直接上下完整展开。
 */
export function DataTableRevealCell({
  primary,
  reveal,
  className,
}: {
  primary: ReactNode
  reveal: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative min-w-0 sm:[@media(hover:hover)]:flex sm:[@media(hover:hover)]:min-h-11 sm:[@media(hover:hover)]:flex-col sm:[@media(hover:hover)]:justify-center",
        className,
      )}
    >
      <div className="min-w-0 transition-transform duration-200 ease-out motion-reduce:transition-none sm:[@media(hover:hover)]:group-data-[active=true]/row:-translate-y-2.5 sm:[@media(hover:hover)]:group-focus-within/row:-translate-y-2.5">
        {primary}
      </div>
      <div className="mt-1 min-w-0 text-[13px] leading-snug text-foreground/80 transition-all duration-200 ease-out motion-reduce:transition-none sm:[@media(hover:hover)]:pointer-events-none sm:[@media(hover:hover)]:absolute sm:[@media(hover:hover)]:inset-x-0 sm:[@media(hover:hover)]:bottom-0 sm:[@media(hover:hover)]:mt-0 sm:[@media(hover:hover)]:translate-y-1 sm:[@media(hover:hover)]:opacity-0 sm:[@media(hover:hover)]:group-data-[active=true]/row:pointer-events-auto sm:[@media(hover:hover)]:group-data-[active=true]/row:translate-y-0 sm:[@media(hover:hover)]:group-data-[active=true]/row:opacity-100 sm:[@media(hover:hover)]:group-focus-within/row:pointer-events-auto sm:[@media(hover:hover)]:group-focus-within/row:translate-y-0 sm:[@media(hover:hover)]:group-focus-within/row:opacity-100">
        {reveal}
      </div>
    </div>
  )
}

/**
 * 鼠标移入行时显现的次要操作组（桌面 hover-reveal，触屏与键盘聚焦常显），高对比实体文字避免禁用错觉。
 */
export function DataTableHoverActions({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 transition-all duration-150 ease-out motion-reduce:transition-none sm:[@media(hover:hover)]:pointer-events-none sm:[@media(hover:hover)]:translate-x-1 sm:[@media(hover:hover)]:opacity-0 sm:[@media(hover:hover)]:group-data-[active=true]/row:pointer-events-auto sm:[@media(hover:hover)]:group-data-[active=true]/row:translate-x-0 sm:[@media(hover:hover)]:group-data-[active=true]/row:opacity-100 sm:[@media(hover:hover)]:group-focus-within/row:pointer-events-auto sm:[@media(hover:hover)]:group-focus-within/row:translate-x-0 sm:[@media(hover:hover)]:group-focus-within/row:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  )
}
