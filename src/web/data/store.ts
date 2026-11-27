import { useSyncExternalStore } from "react"

const THEME_STORAGE_KEY = "hdu-sniper-preferences"
export type Theme = "light" | "dark"

type ThemeStore = {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
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

let state: ThemeStore = {
  theme: readStoredTheme(),
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
}

function updateState(updater: (prev: ThemeStore) => ThemeStore) {
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

export function useAppStore<T>(selector: (store: ThemeStore) => T): T {
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
