import { isTauri } from "./tauri"
import { invoke } from "@tauri-apps/api/core"

export type UpdateState = { available: boolean; version?: string; body?: string; error?: string }

export async function checkForUpdate(): Promise<UpdateState> {
  if (!isTauri()) return { available: false }
  try {
    const { check } = await import("@tauri-apps/plugin-updater")
    const update = await check()
    if (!update) return { available: false }
    return { available: true, version: update.version, body: update.body || undefined }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function installUpdate(): Promise<void> {
  if (!isTauri()) throw new Error("当前环境不支持自动更新")
  const { check } = await import("@tauri-apps/plugin-updater")
  const update = await check()
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
    throw error
  }
}
