import { describe, expect, it } from "vitest"
import { unseenAuditEvents } from "../src/web/notifications"
import type { AuditEvent } from "../src/shared/types"

const event = (id: number, name: string): AuditEvent => ({ id, event: name, payload: {}, createdAt: new Date(0).toISOString() })

describe("system notification event selection", () => {
  it("selects supported unseen events in chronological order", () => {
    expect(unseenAuditEvents([event(3, "checkin_failed"), event(1, "booking_run_finished"), event(2, "login")], [1]).map((item) => item.id)).toEqual([3])
  })

  it("does not select an event that was already notified", () => {
    expect(unseenAuditEvents([event(7, "checkin_succeeded")], [7])).toEqual([])
  })
})
