"use client"

import { useMediaQuery } from "@/hooks/use-media-query"

export type NavMode = "wide" | "medium" | "compact"

/**
 * 三档导航：
 * - wide：>=1280，沿用现有的 256px 侧栏
 * - medium：1024–1279，64px 图标 rail，hover 时覆盖展开
 * - compact：<1024，底部双槽 Floating Dock
 */
export function useNavMode(): NavMode {
  const wide = useMediaQuery("xl")
  const medium = useMediaQuery("lg")
  return wide ? "wide" : medium ? "medium" : "compact"
}
