import { isTauri } from "./tauri"
import type { AuditEvent } from "../shared/types"

const notifiedKey = "hdu-sniper.notification-events"
const interesting = new Set(["booking_run_finished", "checkin_succeeded", "checkin_failed", "checkin_unverified"])

export function unseenAuditEvents(events: AuditEvent[], seenIds: number[]): AuditEvent[] {
  const seen = new Set(seenIds)
  return events.filter((event) => interesting.has(event.event) && !seen.has(event.id)).sort((a, b) => a.id - b.id)
}

function text(event: AuditEvent): string {
  const payload = event.payload
  const result = payload.success === false ? "失败" : payload.success === true ? "成功" : "状态已更新"
  const detail = typeof payload.error === "string" ? `：${payload.error}` : typeof payload.message === "string" ? `：${payload.message}` : ""
  return `${result}${detail}`
}

export async function notifyAuditEvents(events: AuditEvent[]): Promise<void> {
  if (!isTauri() || events.length === 0) return
  const saved = localStorage.getItem(notifiedKey)
  if (saved === null) {
    localStorage.setItem(notifiedKey, JSON.stringify(events.map((event) => event.id).slice(0, 100)))
    return
  }
  const seen = new Set(JSON.parse(saved) as number[])
  const fresh = unseenAuditEvents(events, [...seen])
  if (fresh.length === 0) return
  const notification = await import("@tauri-apps/plugin-notification")
  if (!(await notification.isPermissionGranted())) {
    if (await notification.requestPermission() !== "granted") return
  }
  for (const event of fresh) {
    await notification.sendNotification({ title: "HDU Library Sniper", body: `${event.event}：${text(event)}` })
    seen.add(event.id)
  }
  const ids = [...seen].sort((a, b) => b - a).slice(0, 100)
  localStorage.setItem(notifiedKey, JSON.stringify(ids))
}
