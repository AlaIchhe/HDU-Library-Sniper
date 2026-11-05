import { describe, expect, test } from "vitest"
import { CalendarDays, ListChecks, Moon } from "lucide-react"

import { filterCommands, matchesQuery, type Command } from "../src/web/commands"

const noop = () => {}

const plans: Command = {
  id: "go-plans", label: "预约方案", group: "导航", icon: ListChecks,
  keywords: ["plans", "yuyue", "fangan"], run: noop,
}
const bookings: Command = {
  id: "go-bookings", label: "当前预约", group: "导航", icon: CalendarDays,
  keywords: ["bookings", "dangqian"], run: noop,
}
const theme: Command = {
  id: "theme", label: "切换到深色主题", group: "操作", icon: Moon,
  keywords: ["theme", "zhuti", "qiehuan"], run: noop,
}

const all = [plans, bookings, theme]

describe("command palette matching", () => {
  test("empty query matches everything", () => {
    expect(filterCommands(all, "")).toEqual(all)
    expect(filterCommands(all, "   ")).toEqual(all)
  })

  test("matches the Chinese label directly", () => {
    expect(filterCommands(all, "预约").map((c) => c.id)).toEqual(["go-plans", "go-bookings"])
    expect(filterCommands(all, "主题").map((c) => c.id)).toEqual(["theme"])
  })

  test("matches pinyin keywords", () => {
    expect(matchesQuery(theme, "qiehuan")).toBe(true)
    expect(matchesQuery(theme, "zhuti")).toBe(true)
    expect(matchesQuery(plans, "yuyue")).toBe(true)
  })

  test("is case-insensitive", () => {
    expect(matchesQuery(plans, "PLANS")).toBe(true)
  })

  test("falls back to in-order subsequence matching", () => {
    // 「bks」按顺序出现在 bookings 里
    expect(matchesQuery(bookings, "bks")).toBe(true)
    // 顺序颠倒则不匹配
    expect(matchesQuery(bookings, "skb")).toBe(false)
  })

  test("rejects unrelated queries", () => {
    expect(filterCommands(all, "xyzzy")).toEqual([])
  })
})
