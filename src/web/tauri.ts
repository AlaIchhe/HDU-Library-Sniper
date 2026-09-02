import { invoke } from "@tauri-apps/api/core"

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export type StartupStatus = { enabled: boolean; task_name: string }

export async function getStartupStatus(): Promise<StartupStatus> {
  if (!isTauri()) return { enabled: false, task_name: "HDU-Library-Sniper" }
  if (!navigator.userAgent.includes("Windows")) {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart")
    return { enabled: await isEnabled(), task_name: "HDU-Library-Sniper" }
  }
  return invoke<StartupStatus>("startup_status")
}

export async function setStartupEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  if (!navigator.userAgent.includes("Windows")) {
    const autostart = await import("@tauri-apps/plugin-autostart")
    await (enabled ? autostart.enable() : autostart.disable())
    return
  }
  await invoke(enabled ? "enable_startup" : "disable_startup")
}
