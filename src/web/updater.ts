import { isTauri } from "./tauri"
import { invoke } from "@tauri-apps/api/core"

export type UpdateState = { available: boolean; version?: string; body?: string; error?: string }

// 更新源在 GitHub 上，国内网络下 plugin 的 check() 可能长时间挂起；
// 不设上限 UI 会一直停在“检查中”，用户看不到任何反馈。
const UPDATE_CHECK_TIMEOUT_MS = 15_000

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (!isTauri()) return { available: false }
  try {
    const { check } = await import("@tauri-apps/plugin-updater")
    const update = await withTimeout(check(), UPDATE_CHECK_TIMEOUT_MS, "检查更新超时，请检查网络后重试")
    if (!update) return { available: false }
    return { available: true, version: update.version, body: update.body || undefined }
  } catch (error) {
    if (isTauri()) {
      const { error: logError } = await import("@tauri-apps/plugin-log");
      logError(`检查更新失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function installUpdate(): Promise<void> {
  if (!isTauri()) throw new Error("当前环境不支持自动更新")
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = await withTimeout(check(), UPDATE_CHECK_TIMEOUT_MS, "检查更新超时，请检查网络后重试")
  if (!update) throw new Error("没有可用更新")
  if (!navigator.userAgent.includes("Windows")) {
    await update.downloadAndInstall()
    return
  }
  await update.download()
  await invoke("stop_backend")
  try {
    await update.install()
  } catch (error) {
    await invoke("start_backend").catch(() => undefined)
    if (isTauri()) {
      const { error: logError } = await import("@tauri-apps/plugin-log");
      logError(`安装更新失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error
  }
}
