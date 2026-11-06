import type { LucideIcon } from "lucide-react"

/** 命令面板里的一个可执行条目。 */
export type Command = {
  /** 稳定标识，用作 React key 与选中态。 */
  id: string
  label: string
  /** 分组标题，同组连续排列。 */
  group: string
  icon: LucideIcon
  /** 附加到搜索索引的关键词（拼音首字母、英文别名等）。 */
  keywords?: string[]
  /** 展示在右侧的快捷键提示。 */
  shortcut?: string
  run: () => void
}

/** 极简模糊匹配：空查询全通过；否则要求每个字符按顺序出现。 */
export function matchesQuery(command: Command, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true

  const haystack = [command.label, ...(command.keywords ?? [])].join(" ").toLowerCase()

  if (haystack.includes(needle)) return true

  // 退化为子序列匹配，容忍「yuyuefangan」这类连续输入
  let index = 0
  for (const char of needle) {
    index = haystack.indexOf(char, index)
    if (index === -1) return false
    index += 1
  }
  return true
}

export function filterCommands(commands: Command[], query: string): Command[] {
  if (!query.trim()) return commands
  return commands.filter((command) => matchesQuery(command, query))
}
