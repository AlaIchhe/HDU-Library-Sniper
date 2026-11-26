"use client"

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { motion, useReducedMotion } from "motion/react"

import { Dialog, DialogPanel, DialogPopup } from "@/ui/dialog"
import { AnimateIcon, Search } from "@/ui/icons"
import { MenuShortcut } from "@/ui/menu"
import { ShineBorder } from "@/ui/shine-border"
import { cn } from "@/lib/utils"
import type { Command } from "../commands"
import { filterCommands } from "../commands"

type CommandPaletteProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: Command[]
}

/**
 * 命令面板：⌘K / Ctrl+K 打开，输入过滤，↑↓ 选择，Enter 执行。
 *
 * 用受控 Input + 自管选中态而不是 Base UI Combobox：面板的列表很短、
 * 键盘模型只有一个维度，自己管状态比把 Combobox 塞进 Dialog 的 portal
 * 里更可预测，也不用跟它的过滤/滚动容器打架（滚动交给 DialogPanel）。
 */
export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  const results = filterCommands(commands, query)
  const activeCommand = results[activeIndex]
  const activeOptionId = activeCommand ? `${listboxId}-opt-${activeCommand.id}` : undefined

  const groups: Array<{ name: string; entries: Array<{ command: Command; index: number }> }> = []
  for (let index = 0; index < results.length; index += 1) {
    const command = results[index]
    const last = groups[groups.length - 1]
    if (last && last.name === command.group) {
      last.entries.push({ command, index })
    } else {
      groups.push({ name: command.group, entries: [{ command, index }] })
    }
  }

  // 打开时重置，避免上次的查询/选中残留
  useEffect(() => {
    if (!open) return
    setQuery("")
    setActiveIndex(0)
    // Dialog 的入场动画结束后再聚焦，否则输入框会抢走过渡的焦点
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [open])

  // 过滤结果变化后，选中项可能越界
  useEffect(() => {
    setActiveIndex((index) => (index >= results.length ? 0 : index))
  }, [results.length])

  // 全局 ⌘K / Ctrl+K：这个组合带修饰键，不走 useHotkeys（那边会主动跳过）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      onOpenChange(!open)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onOpenChange])

  function runCommand(command: Command) {
    onOpenChange(false)
    // 先关闭再执行：避免命令触发的导航/弹窗与面板的退场动画叠在一起
    window.setTimeout(() => command.run(), 0)
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((index) => (results.length ? (index + 1) % results.length : 0))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((index) => (results.length ? (index - 1 + results.length) % results.length : 0))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const command = results[activeIndex]
      if (command) runCommand(command)
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      setActiveIndex(Math.max(0, results.length - 1))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        // 顶部对齐 + 固定最大高度：
        // viewport 是 grid-rows-[1fr_auto_3fr]，行高由内容决定，所以 popup 上的
        // max-h-full 永远不生效（父级没有确定高度），面板会撑出边框外。
        // 用视口单位给出确定上限，再让 DialogPanel 作为 flex 子项在内部滚动。
        className="row-start-1 max-h-[min(80dvh,30rem)] max-w-xl self-start overflow-hidden"
      >
        <ShineBorder borderWidth={1} duration={16} />
        <div className="flex items-center gap-3 border-b px-4">
          <Search
            className="size-4 shrink-0 text-muted-foreground"
            animate={query.length > 0 ? "find" : false}
            animateOnHover
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索命令…"
            aria-label="搜索命令"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            className="h-12 w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/72"
          />
          <MenuShortcut className="me-0 shrink-0">ESC</MenuShortcut>
        </div>

        {/* min-h-0 是关键：没有它，flex 子项的默认 min-height:auto
            会让内容把面板撑高，ScrollArea 就不会滚动。 */}
        <DialogPanel className="min-h-0 flex-1 p-2">
          {results.length ? (
            <div id={listboxId} className="grid gap-1" role="listbox" aria-label="命令">
              {groups.map((group) => {
                const headingId = `${listboxId}-group-${group.name}`
                return (
                  // biome-ignore lint/a11y/useSemanticElements: listbox 选项分组按 ARIA 规范使用 role="group"
                  <div key={group.name} role="group" aria-labelledby={headingId} className="grid gap-0.5">
                    <div
                      id={headingId}
                      className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground/80 first:pt-1"
                    >
                      {group.name}
                    </div>
                    {group.entries.map(({ command, index }) => (
                      <CommandRow
                        key={command.id}
                        id={`${listboxId}-opt-${command.id}`}
                        command={command}
                        index={index}
                        active={index === activeIndex}
                        onHover={() => setActiveIndex(index)}
                        onSelect={() => runCommand(command)}
                      />
                    ))}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的命令</p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function CommandRow({
  id,
  command,
  index,
  active,
  onHover,
  onSelect,
}: {
  id: string
  command: Command
  index: number
  active: boolean
  onHover: () => void
  onSelect: () => void
}) {
  const Icon = command.icon
  const reduced = useReducedMotion()
  const rowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (active) {
      rowRef.current?.scrollIntoView({ block: "nearest" })
    }
  }, [active])

  return (
    <div
      className="animate-enter-rise [--enter-duration:180ms] [--enter-y:6px]"
      style={{ "--enter-delay": `${Math.min(index, 8) * 18}ms` } as CSSProperties}
    >
      <AnimateIcon animateOnHover asChild>
        <button
          ref={rowRef}
          id={id}
          type="button"
          role="option"
          aria-selected={active}
          onClick={onSelect}
          onPointerEnter={onHover}
          className={cn(
            "relative flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none",
            "transition-colors duration-100",
            active ? "text-accent-foreground" : "text-foreground",
          )}
          data-active={active}
        >
          {/* 共享 layoutId 的选中滑块：在条目之间滑动，而不是各条目自己变色 */}
          {active && (
            <motion.span
              layoutId="command-palette-active"
              aria-hidden
              className="absolute inset-0 -z-10 rounded-lg bg-accent"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 36, mass: 0.6 }}
            />
          )}
          <Icon className="size-4 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate">{command.label}</span>
          {command.shortcut ? (
            <MenuShortcut className="me-0 shrink-0">{command.shortcut}</MenuShortcut>
          ) : null}
        </button>
      </AnimateIcon>
    </div>
  )
}
