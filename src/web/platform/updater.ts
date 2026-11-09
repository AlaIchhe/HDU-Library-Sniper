import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater"

import { isTauri } from "./tauri"
import { applyDownloadEvent, commitUpdateProgress, emptyTick, getUpdateProgress } from "../update-state"

/** 更新源在 GitHub 上，国内直连经常挂住，所有请求都要自带超时。 */
const checkTimeoutMs = 15_000
/** 整包接近 60 MB，慢速网络也要几分钟；但断流必须能失败，不能永远停在某个百分比。 */
const downloadTimeoutMs = 15 * 60_000
/** 开机那一刻网络常常还没就绪，检查失败后按这个间隔补两次，之后放弃。 */
const retryDelaysMs = [15_000, 60_000]
/** 让一让启动阶段的后端探测和登录请求。 */
const startDelayMs = 5_000

/** check 出来的更新对象，下载和安装都复用它，避免点一次再等十几秒。 */
let pending: Update | null = null
let installing = false
let scheduled = false
/** 已经拿到明确答案（有更新或确实没有），不再重复查。 */
let settled = false
let checking = false

/**
 * 启动后查一次有没有新版本。全程静默：失败只写日志，
 * 检出更新也只点亮顶栏控件，不下载任何字节。
 */
export function startUpdateCheck(): void {
  if (scheduled || !isTauri() || !import.meta.env.PROD) return
  scheduled = true
  // 开机时网卡常常还没就绪：联网事件来了再补一次。
  window.addEventListener("online", () => {
    if (!settled) void checkOnce(0)
  })
  setTimeout(() => void checkOnce(0), startDelayMs)
}

async function checkOnce(attempt: number): Promise<void> {
  if (checking) return
  checking = true
  try {
    const update = await lookup()
    settled = true
    if (!update) {
      commitUpdateProgress({ phase: "idle" })
      return
    }
    pending = update
    commitUpdateProgress({ phase: "available", version: update.version, percent: 0, received: 0, total: 0 })
  } catch (error) {
    await report("检查更新失败", error)
    const delay = retryDelaysMs[attempt]
    if (delay !== undefined) setTimeout(() => void checkOnce(attempt + 1), delay)
  } finally {
    checking = false
  }
}

/**
 * 下载并安装已检出的更新。成功时 Windows 安装器会直接结束进程，
 * 所以这里只要保证失败时能退回可点击状态。
 */
export async function installPendingUpdate(): Promise<void> {
  if (installing || getUpdateProgress().phase !== "available") return
  installing = true
  commitUpdateProgress({ phase: "downloading", percent: 0, received: 0, total: 0 })

  let stale = false
  try {
    const update = await resolvePending()
    if (!update) {
      stale = true
      commitUpdateProgress({ phase: "idle" })
      throw new Error("当前已是最新版本")
    }
    await download(update)
    commitUpdateProgress({ phase: "installing" })
    await update.install()
  } catch (error) {
    await release()
    if (!stale) commitUpdateProgress({ phase: "available", percent: 0, received: 0, total: 0 })
    await report("更新失败", error)
    throw error
  } finally {
    installing = false
  }
}

async function resolvePending(): Promise<Update | null> {
  if (pending) return pending
  const update = await lookup()
  if (!update) return null
  pending = update
  commitUpdateProgress({ version: update.version })
  return update
}

async function lookup(): Promise<Update | null> {
  const { check } = await import("@tauri-apps/plugin-updater")
  return check({ timeout: checkTimeoutMs })
}

async function download(update: Update): Promise<void> {
  let tick = emptyTick
  await update.download(
    (event: DownloadEvent) => {
      if (event.event === "Finished") {
        // Finished 在签名校验之前触发，这里还不是成功。
        commitUpdateProgress({ phase: "verifying", percent: 100 })
        return
      }
      const step = applyDownloadEvent(tick, event)
      if (step === tick) return
      const changed = step.percent !== tick.percent || step.total !== tick.total
      tick = step
      // 一个 58 MB 的包会推来数千个分块，只在百分比真的变了才渲染。
      if (changed) commitUpdateProgress({ received: tick.received, total: tick.total, percent: tick.percent })
    },
    { timeout: downloadTimeoutMs },
  )
}

async function release(): Promise<void> {
  const update = pending
  pending = null
  if (update) await update.close().catch(() => undefined)
}

async function report(message: string, error: unknown): Promise<void> {
  if (!isTauri()) return
  try {
    const { error: logError } = await import("@tauri-apps/plugin-log")
    logError(`${message}: ${error instanceof Error ? error.message : String(error)}`)
  } catch {
    /* 日志插件不可用时保持静默 */
  }
}
