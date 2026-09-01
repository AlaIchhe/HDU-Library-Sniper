import { AuthService } from "./auth";
import { createGroup, createPlan, deleteGroup, deletePlan, enablePlanItem, getPlanItem, listPlanItems, referencedPlanIds, updateGroup, updatePlan } from "./plans";
import { Scheduler } from "./scheduler";
import * as catalog from "./catalog";
import { listAudit } from "./db";
import { bookingDayOffsetFor } from "./config";

export function createApi(auth: AuthService, scheduler: Scheduler) {
  const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
  const requireAuth = () => auth.authenticated ? undefined : json({ detail: "authentication required" }, { status: 401 });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ status: "ok" });
    if (url.pathname === "/api/session" && request.method === "GET") return json(auth.status());
    if (url.pathname === "/api/session/login" && request.method === "POST") {
      const body = await request.json() as { studentId?: string; password?: string };
      return json(await auth.login(body.studentId || "", body.password || ""));
    }
    const unauthorized = requireAuth();
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/audit" && request.method === "GET") {
      return json({ events: listAudit(Number(url.searchParams.get("limit")) || 20) });
    }
    if (url.pathname === "/api/plans" && request.method === "GET") return json({ plans: listPlanItems() });
    if (url.pathname === "/api/plans" && request.method === "POST") return json({ plan: createPlan(await request.json()) }, { status: 201 });
    const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)(?:\/(enable|disable))?$/);
    if (planMatch) {
      const id = decodeURIComponent(planMatch[1]);
      const action = planMatch[2];
      if (request.method === "GET") {
        const item = getPlanItem(id);
        return item ? json({ plan: item }) : json({ detail: "方案不存在" }, { status: 404 });
      }
      if (request.method === "DELETE") {
        const item = getPlanItem(id);
        if (!item) return json({ detail: "方案不存在" }, { status: 404 });
        if (item.kind === "single" && referencedPlanIds(id).length) return json({ detail: "该单条方案已被组合引用，请先移出组合" }, { status: 409 });
        return (item.kind === "group" ? deleteGroup(id) : deletePlan(id)) ? json({ success: true }) : json({ detail: "方案不存在" }, { status: 404 });
      }
      if (request.method === "PATCH") {
        const item = getPlanItem(id);
        if (!item) return json({ detail: "方案不存在" }, { status: 404 });
        if (item.kind === "group") {
          const body = await request.json() as { name?: string; memberPlanIds?: string[] };
          return json({ plan: updateGroup(id, body.name || item.name, body.memberPlanIds || item.memberPlanIds) });
        }
        return json({ plan: updatePlan(id, await request.json()) });
      }
      if (request.method === "POST" && action) {
        const result = enablePlanItem(id, action === "enable");
        return json({ plan: result.item, disabledPlanIds: result.disabledPlanIds });
      }
    }
    if (url.pathname === "/api/groups" && request.method === "POST") {
      const body = await request.json() as { name?: string; memberPlanIds?: string[] };
      return json({ plan: createGroup(body.name || "", body.memberPlanIds || []) }, { status: 201 });
    }
    const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const id = decodeURIComponent(groupMatch[1]);
      if (request.method === "GET") return json({ plan: getPlanItem(id) });
      if (request.method === "PATCH") {
        const body = await request.json() as { name?: string; memberPlanIds?: string[] };
        return json({ plan: updateGroup(id, body.name || "", body.memberPlanIds || []) });
      }
      if (request.method === "DELETE") return deleteGroup(id) ? json({ success: true }) : json({ detail: "组合方案不存在" }, { status: 404 });
    }
    if (url.pathname === "/api/booking/run" && request.method === "POST") return json(await scheduler.runNow());
    if (url.pathname === "/api/runtime/status") return json(scheduler.status());
    if (url.pathname === "/api/runtime/next-target") {
      const now = new Date();
      const enabled = listPlanItems().find((item) => item.enabled);
      const enabledRoomType = enabled?.kind === "single"
        ? enabled.roomType
        : enabled?.kind === "group"
          ? enabled.members?.[0]?.roomType
          : undefined;
      const offset = bookingDayOffsetFor(enabledRoomType);
      const target = new Date(now); target.setDate(target.getDate() + offset); target.setHours(20, 0, 0, 0);
      const booking = enabled ? { kind: "booking" as const, label: "预约", at: target.toLocaleString("zh-CN", { hour12: false }), planId: enabled.id, time: target.getTime() } : undefined;
      let checkin: { kind: "check-in"; label: string; at: string; bookingId: string; time: number } | undefined;
      if (scheduler.autoCheckInEnabled) {
        const bookings = await auth.client.bookings();
        const pending = bookings.filter((item) => String(item.status || "") === "0").map((item) => {
          const start = Number(item.time || 0) - Number(item.limitSignAgo || 0);
          return { kind: "check-in" as const, label: "签到", at: new Date(start * 1000).toLocaleString("zh-CN", { hour12: false }), bookingId: String(item.id || ""), time: start * 1000 };
        }).filter((item) => item.time >= Date.now()).sort((a, b) => a.time - b.time)[0];
        checkin = pending;
      }
      const next = [booking, checkin].filter(Boolean).sort((a, b) => (a as { time: number }).time - (b as { time: number }).time)[0] as typeof booking | typeof checkin | undefined;
      return json(next ? { kind: next.kind, label: next.label, at: next.at, planId: "planId" in next ? next.planId : undefined, bookingId: "bookingId" in next ? next.bookingId : undefined } : { kind: "none", label: "暂无待执行任务" });
    }
    if (url.pathname === "/api/checkin" && request.method === "GET") return json({ enabled: scheduler.autoCheckInEnabled, consentVersion: scheduler.consentVersion, consentedAt: scheduler.consentedAt });
    if (url.pathname === "/api/checkin/enable" && request.method === "POST") {
      const body = await request.json() as { agreed?: boolean };
      if (!body.agreed) return json({ detail: "启用自动签到需要确认风险协议" }, { status: 409 });
      scheduler.setAutoCheckIn(true, true);
      return json({ enabled: true, consentVersion: scheduler.consentVersion, consentedAt: scheduler.consentedAt });
    }
    if (url.pathname === "/api/checkin/disable" && request.method === "POST") { scheduler.setAutoCheckIn(false); return json({ enabled: false, consentVersion: scheduler.consentVersion, consentedAt: scheduler.consentedAt }); }
    if (url.pathname === "/api/catalog/room-types" && request.method === "GET") return json({ options: await catalog.roomTypes(auth) });
    if (url.pathname === "/api/catalog/floors" && request.method === "GET") return json(await catalog.floors(auth, url.searchParams.get("roomQuery") || "", url.searchParams.get("roomType") || undefined));
    if (url.pathname === "/api/catalog/durations" && request.method === "GET") return json(await catalog.durations(auth, url.searchParams.get("roomQuery") || "", Number(url.searchParams.get("startHour")), url.searchParams.get("roomType") || undefined));
    const bookingMatch = url.pathname.match(/^\/api\/bookings\/([^/]+)\/(cancel|check-in|check-in-test|leave|come-back|renew|sign-out)$/);
    if (bookingMatch) {
      const bookingId = decodeURIComponent(bookingMatch[1]);
      const action = bookingMatch[2];
      if (action === "check-in-test") {
        const bookings = await auth.client.bookings();
        const item = bookings.find((candidate) => String(candidate.id) === bookingId);
        const now = Number(item?.nowTime || 0);
        const begin = Number(item?.time || 0);
        const available = Boolean(item && String(item.status) === "0" && now >= begin - Number(item.limitSignAgo || 0) && now <= begin + Number(item.limitSignBack || 0));
        return json({ success: available, message: available ? "签到窗口已开启" : "当前尚未进入签到窗口" });
      }
      const kind = action === "check-in" ? "checkIn" : action === "come-back" || action === "renew" ? "comeBack" : action === "sign-out" ? "signOut" : action;
      await auth.client.action(kind as "cancel" | "checkIn" | "comeBack" | "leave" | "signOut", bookingId);
      const refreshed = await auth.client.bookings();
      const exists = refreshed.some((candidate) => String(candidate.id) === bookingId);
      if (action !== "cancel" && !exists) return json({ success: false, message: "操作后未能复核预约状态" }, { status: 409 });
      return json({ success: true, message: "操作成功" });
    }
    if (url.pathname === "/api/bookings/current" && request.method === "GET") {
      const raw = await auth.client.bookings();
      const bookings = raw.filter((item) => !["3", "4", "7"].includes(String(item.status || ""))).map((item) => {
        const status = String(item.status || "");
        const begin = Number(item.time || 0) * 1000;
        const canCheckIn = status === "0" && Number(item.nowTime || 0) >= Number(item.time || 0) - Number(item.limitSignAgo || 0);
        return {
          bookingId: String(item.id || ""),
          roomName: String(item.roomName || "未知房间"),
          seatNum: String(item.seatNum || "-"),
          startText: begin ? new Date(begin).toLocaleString("zh-CN", { hour12: false }) : "未知时间",
          durationText: `${Number(item.duration || 0) / 3600 || 0} 小时`,
          status,
          state: canCheckIn ? "check_in" : status === "1" ? "in_use" : status === "2" ? "away" : "pending",
          statusLabel: canCheckIn ? "可签到" : status === "1" ? "使用中" : status === "2" ? "暂离中" : "待签到",
          canCancel: status === "0" || status === "8",
          canCheckIn,
          canSignOut: status === "1",
          canLeave: status === "1",
          canRenew: status === "2",
        };
      });
      return json({ bookings });
    }
    return json({ detail: "not found" }, { status: 404 });
  };
}
