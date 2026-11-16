import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import type { SessionStatus } from "../../shared/types"

const THEME_STORAGE_KEY = "hdu-sniper-preferences"
type Theme = "light" | "dark"

type AppStore = {
  session: SessionStatus | null
  theme: Theme
  /**
   * 自增计数器：命令面板 / 快捷键请求「刷新当前页」时 +1，
   * 页面用 useRefreshSignal 订阅。用广播而不是 DOM 查询，
   * 页面自己决定刷什么（各自的 react-query key）。
   */
  refreshRequest: number
  setSession: (session: SessionStatus | null) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  requestRefresh: () => void
}

function getStorage(): Storage | undefined {
  return (typeof window !== "undefined" ? window.localStorage : undefined) ?? globalThis.localStorage
}

function readStoredTheme(): Theme {
  try {
    const raw = getStorage()?.getItem(THEME_STORAGE_KEY)
    if (!raw) return "light"
    const parsed = JSON.parse(raw) as { state?: { theme?: unknown } }
    return parsed?.state?.theme === "dark" ? "dark" : "light"
  } catch {
    return "light"
  }
}

function writeStoredTheme(theme: Theme) {
  try {
    getStorage()?.setItem(THEME_STORAGE_KEY, JSON.stringify({ state: { theme }, version: 0 }))
  } catch {
    // 无痕模式 / 受限存储下忽略写入错误，仅保留内存状态
  }
}

function applyThemeClass(theme: Theme) {
  globalThis.document?.documentElement.classList.toggle("dark", theme === "dark")
}

const listeners = new Set<() => void>()

let state: AppStore = {
  session: null,
  theme: readStoredTheme(),
  refreshRequest: 0,
  setSession: (session) =>
    updateState((prev) => (Object.is(prev.session, session) ? prev : { ...prev, session })),
  setTheme: (theme) => {
    applyThemeClass(theme)
    writeStoredTheme(theme)
    updateState((prev) => (prev.theme === theme ? prev : { ...prev, theme }))
  },
  toggleTheme: () => {
    const next: Theme = state.theme === "dark" ? "light" : "dark"
    applyThemeClass(next)
    writeStoredTheme(next)
    updateState((prev) => ({ ...prev, theme: next }))
  },
  requestRefresh: () => updateState((prev) => ({ ...prev, refreshRequest: prev.refreshRequest + 1 })),
}

function updateState(updater: (prev: AppStore) => AppStore) {
  const next = updater(state)
  if (Object.is(next, state)) return
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAppStore<T>(selector: (store: AppStore) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  )
}

useAppStore.getState = () => state

export function initializeTheme() {
  applyThemeClass(state.theme)
}

/**
 * 订阅「刷新当前页」广播。首次挂载不触发，只在计数增加时调用 handler，
 * 避免页面刚打开就白白多刷一次。
 */
export function useRefreshSignal(handler: () => void) {
  const count = useAppStore((store) => store.refreshRequest)
  const seen = useRef(count)
  const handlerRef = useRef(handler)

  useLayoutEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    if (count === seen.current) return
    seen.current = count
    handlerRef.current()
  }, [count])
}
