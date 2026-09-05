export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener")
    await openUrl(url)
    return
  }
  window.open(url, "_blank", "noopener,noreferrer")
}

