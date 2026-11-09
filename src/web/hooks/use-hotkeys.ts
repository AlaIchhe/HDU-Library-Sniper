import { useEffect, useRef } from "react"

/** 单个按键序列：`g p` 用 ["g", "p"] 表示。 */
export type HotkeySequence = readonly string[]

export type HotkeyMap = Record<string, () => void>

/** 序列前缀的有效期：按了 `g` 之后超过这个时间没跟上第二个键就作废。 */
const SEQUENCE_TIMEOUT_MS = 1000

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

/** 归一化按键：同时接受 a-z 与数字，忽略大小写。 */
function normalizeKey(event: KeyboardEvent): string | null {
  const { key } = event
  if (key === " " || key === "Spacebar") return "space"
  if (key.startsWith("Arrow")) return key.slice(5).toLowerCase()
  if (key.length === 1) return key.toLowerCase()
  if (key === "Escape" || key === "Enter") return key.toLowerCase()
  return null
}

/**
 * 注册全局快捷键。
 *
 * 设计取舍：
 *  - 输入框（input/textarea/contenteditable）内的按键一律放行，避免打断打字；
 *  - 忽略 `event.repeat`，长按不会把序列触发多次；
 *  - 序列（`g p`）带超时，超时后回到初始状态；
 *  - 命中后才 `preventDefault`，不命中时不影响浏览器的原生行为。
 *
 * 注意：`src/ui/sidebar.tsx` 自己也监听 window keydown 并处理 ⌘/Ctrl+B，
 * 且它无条件 preventDefault。这里不要再占用 `b` 作为单键或序列起始键。
 */
export function useHotkeys(map: HotkeyMap, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (!enabled) return

    let pending: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearPending = () => {
      pending = null
      if (timer) clearTimeout(timer)
      timer = undefined
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // 带修饰键的组合交给浏览器 / 其他监听器（如侧边栏的 ⌘B）
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.repeat) return
      if (isEditableTarget(event.target)) return

      const key = normalizeKey(event)
      if (!key) return

      const hotkeys = mapRef.current

      if (pending !== null) {
        const sequence = `${pending} ${key}`
        const handler = hotkeys[sequence]
        clearPending()
        if (handler) {
          event.preventDefault()
          handler()
        }
        return
      }

      // 单键优先命中；否则看它是不是某个序列的开头
      const direct = hotkeys[key]
      if (direct) {
        event.preventDefault()
        direct()
        return
      }

      const startsSequence = Object.keys(hotkeys).some((combo) => combo.startsWith(`${key} `))
      if (startsSequence) {
        pending = key
        timer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      clearPending()
    }
  }, [enabled])
}

/** 把 `["g", "p"]` 拼成 map 的 key。 */
export function sequence(...keys: string[]): string {
  return keys.join(" ")
}
