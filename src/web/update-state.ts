import type { DownloadEvent } from "@tauri-apps/plugin-updater"

export type UpdatePhase = "idle" | "available" | "downloading" | "verifying" | "installing"

export type UpdateProgress = {
  phase: UpdatePhase
  version?: string
  percent: number
  received: number
  total: number
}

export type DownloadTick = { received: number; total: number; percent: number }

export const emptyTick: DownloadTick = { received: 0, total: 0, percent: 0 }

const idle: UpdateProgress = { phase: "idle", percent: 0, received: 0, total: 0 }

let progress: UpdateProgress = idle
const listeners = new Set<() => void>()

export function commitUpdateProgress(patch: Partial<UpdateProgress>) {
  progress = { ...progress, ...patch }
  for (const listener of listeners) listener()
}

export function subscribeUpdateProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getUpdateProgress(): UpdateProgress {
  return progress
}

/** 已下载占比；总量未知（服务端没给 Content-Length）时返回 0，界面据此显示不定态。 */
export function percentOf(received: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.floor((received / total) * 100)))
}

/**
 * 按插件事件推进下载计数。Progress 带的是本块增量，必须自己累加；
 * Finished 不在这里处理——它在签名校验之前触发，不代表成功。
 */
export function applyDownloadEvent(tick: DownloadTick, event: DownloadEvent): DownloadTick {
  if (event.event === "Started") {
    return { received: 0, total: event.data.contentLength ?? 0, percent: 0 }
  }
  if (event.event === "Progress") {
    const received = tick.received + event.data.chunkLength
    return { received, total: tick.total, percent: percentOf(received, tick.total) }
  }
  return tick
}
export type UpdateCheckState = {
  now: number
  lastCheckAt: number
  phase: UpdatePhase
  checking: boolean
  cooldownMs?: number
}

/** 同一冷却窗口内只允许一次检查；已有待安装更新时不要覆盖状态。 */
export function canCheckUpdate(state: UpdateCheckState): boolean {
  const cooldown = state.cooldownMs ?? 10 * 60_000
  return !state.checking && state.phase === "idle" && state.now - state.lastCheckAt >= cooldown
}
