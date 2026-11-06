import { useEffect, useState } from "react"

/** 把 ISO 时间拆成可读的相对倒计时。 */
export type Countdown = {
  /** 已过期的毫秒数（未过期时为 0）。 */
  overdueMs: number
  /** 距离目标还有多久（已过期时为 0）。 */
  remainingMs: number
  text: string
  expired: boolean
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

function compute(targetMs: number, now: number): Countdown {
  const delta = targetMs - now
  if (delta <= 0) {
    return { overdueMs: -delta, remainingMs: 0, text: "即将执行", expired: true }
  }
  return { overdueMs: 0, remainingMs: delta, text: formatRemaining(delta), expired: false }
}

/**
 * 每秒重算一次的倒计时。
 *
 * 只驱动本地展示，不发任何网络请求——项目的数据策略是「聚焦/操作时刷新，
 * 不轮询」，这个 timer 不能破坏那个约定。
 */
export function useCountdown(iso?: string): Countdown | null {
  const targetMs = iso ? new Date(iso).getTime() : null
  const valid = targetMs !== null && Number.isFinite(targetMs)

  const [state, setState] = useState<Countdown | null>(() => (valid ? compute(targetMs, Date.now()) : null))

  useEffect(() => {
    if (!valid) {
      setState(null)
      return
    }

    const tick = () => setState(compute(targetMs, Date.now()))
    tick()

    // 秒级对齐：先对齐到下一个整秒，再按 1s 走，避免秒数跳动
    let interval: ReturnType<typeof setInterval> | undefined
    const align = window.setTimeout(
      () => {
        tick()
        interval = setInterval(tick, 1000)
      },
      1000 - (Date.now() % 1000),
    )

    return () => {
      window.clearTimeout(align)
      if (interval) clearInterval(interval)
    }
  }, [targetMs, valid])

  return state
}
