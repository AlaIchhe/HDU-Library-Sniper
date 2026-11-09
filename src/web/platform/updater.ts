import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater"

import { isTauri } from "./tauri"
import {
  applyDownloadEvent,
  canCheckUpdate,
  commitUpdateProgress,
  emptyTick,
  getUpdateProgress,
} from "../update-state"

/** 更新源在 GitHub 上，国内直连经常挂住，所有请求都要自带超时。 */
const checkTimeoutMs = 15_000
/** 整包接近 60 MB，慢速网络也要几分钟；但断流必须能失败，不能永远停在某个百分比。 */
const downloadTimeoutMs = 15 * 60_000
/** 同一时间窗口内最多查一次，避免 Alt-Tab 来回切时反复请求 GitHub。 */
const CHECK_COOLDOWN_MS = 10 * 60_000

/** check 出来的更新对象，下载和安装都复用它，避免点一次再等十几秒。 */
let pending: Update | null = null
let installing = false
let started = false
let checking = false
let lastCheckAt = 0

/**
 * 只在用户把窗口带回前台时检查：
 * - Alt-Tab / 任务栏切换：window focus；
 * - 最小化恢复：visibilitychange；
 * - 关闭到托盘后从托盘打开：Rust 侧显式 emit 的 tray-window-shown。
 * 首次启动不检查，后台常驻也不检查。
 */
export function startUpdateCheck(): void {
  if (started || !isTauri() || !import.meta.env.PROD) return
  started = true

  const trigger = (source: string) => {
    const phase = getUpdateProgress().phase
    const allowed = canCheckUpdate({
      now: Date.now(),
      lastCheckAt,
      phase,
      checking,
      cooldownMs: CHECK_COOLDOWN_MS,
    })
    if (!allowed) return
    lastCheckAt = Date.now()
    void checkOnce(source)
  }

  window.addEventListener("focus", () => trigger("focus"))
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") trigger("visible")
  })
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen("tray-window-shown", () => trigger("tray")))
    .catch((error: unknown) => report("订阅托盘事件失败", error))
}

async function checkOnce(source: string): Promise<void> {
  checking = true
  try {
    await note(`检查更新（${source}）`)
    const update = await lookup()
    commitUpdateProgress(
      update
        ? { phase: "available", version: update.version, percent: 0, received: 0, total: 0 }
        : { phase: "idle", percent: 0, received: 0, total: 0 },
    )
  } catch (error) {
    await report(`检查更新失败（${source}）`, error)
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

async function note(message: string): Promise<void> {
  if (!isTauri()) return
  try {
    const { info } = await import("@tauri-apps/plugin-log")
    info(message)
  } catch {
    /* 日志插件不可用时保持静默 */
  }
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
