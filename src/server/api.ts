import type { AuthService } from "./auth";
import {
  createGroup,
  createPlan,
  deleteGroup,
  deletePlan,
  enablePlanItem,
  getPlanItem,
  listPlanItems,
  referencedPlanIds,
  updateGroup,
  updatePlan,
} from "./plans";
import type { Scheduler } from "./scheduler";
import * as catalog from "./catalog";
import { getClashDirectStatus, setClashDirect } from "./clash";
import { listAudit } from "./db";
import { nextBookingAnchor, timezone } from "./config";

export function createApi(auth: AuthService, scheduler: Scheduler) {
  const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);
  const requireAuth = () =>
    auth.authenticated ? undefined : json({ detail: "authentication required" }, { status: 401 });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ status: "ok" });
    if (url.pathname === "/api/session" && request.method === "GET") return json(auth.status());
    if (url.pathname === "/api/session/login" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { studentId?: string; password?: string };
      const result = await auth.login(body.studentId || "", body.password || "");
      if (result.success) void scheduler.syncCheckIns("login");
      return json(result);
    }
    if (url.pathname === "/api/session/openid" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { openid?: string };
      const result = await auth.loginWithOpenid(body.openid || "");
      if (result.success) void scheduler.syncCheckIns("openid");
      return json(result);
    }
    if (url.pathname === "/api/session/qr" && request.method === "POST") {
      return json(await auth.createQrLogin());
    }
    const qrMatch = url.pathname.match(/^\/api\/session\/qr\/([^/]+)\/status$/);
    if (qrMatch && request.method === "GET") {
      const result = await auth.pollQrLogin(decodeURIComponent(qrMatch[1]));
      if (result.status === "confirmed") void scheduler.syncCheckIns("qr-login");
      return json(result);
    }
    // Clash 控制不需要登录态：登录被代理问题卡住时正是需要它的时候。
    if (url.pathname === "/api/clash/direct" && request.method === "GET")
      return json(await getClashDirectStatus());
    if (url.pathname === "/api/clash/direct" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
      return json(await setClashDirect(Boolean(body.enabled)));
    }
    if (url.pathname === "/api/session/logout" && request.method === "POST") {
      auth.logout();
      return json({ success: true });
    }
    const unauthorized = requireAuth();
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/audit" && request.method === "GET") {
      return json({ events: listAudit(Number(url.searchParams.get("limit")) || 20) });
    }
    if (url.pathname === "/api/plans" && request.method === "GET") return json({ plans: listPlanItems() });
    if (url.pathname === "/api/plans" && request.method === "POST")
      return json({ plan: createPlan(await request.json()) }, { status: 201 });
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
        if (item.kind === "single" && referencedPlanIds(id).length)
          return json({ detail: "该单条方案已被组合引用，请先移出组合" }, { status: 409 });
        return (item.kind === "group" ? deleteGroup(id) : deletePlan(id))
          ? json({ success: true })
          : json({ detail: "方案不存在" }, { status: 404 });
      }
      if (request.method === "PATCH") {
        const item = getPlanItem(id);
        if (!item) return json({ detail: "方案不存在" }, { status: 404 });
        if (item.kind === "group") {
          const body = (await request.json()) as { name?: string; memberPlanIds?: string[] };
          return json({
            plan: updateGroup(id, body.name || item.name, body.memberPlanIds || item.memberPlanIds),
          });
        }
        return json({ plan: updatePlan(id, await request.json()) });
      }
      if (request.method === "POST" && action) {
        const result = enablePlanItem(id, action === "enable");
        return json({ plan: result.item, disabledPlanIds: result.disabledPlanIds });
      }
    }
    if (url.pathname === "/api/groups" && request.method === "POST") {
      const body = (await request.json()) as { name?: string; memberPlanIds?: string[] };
      return json({ plan: createGroup(body.name || "", body.memberPlanIds || []) }, { status: 201 });
    }
    const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const id = decodeURIComponent(groupMatch[1]);
      if (request.method === "GET") return json({ plan: getPlanItem(id) });
      if (request.method === "PATCH") {
        const body = (await request.json()) as { name?: string; memberPlanIds?: string[] };
        return json({ plan: updateGroup(id, body.name || "", body.memberPlanIds || []) });
      }
      if (request.method === "DELETE")
        return deleteGroup(id)
          ? json({ success: true })
          : json({ detail: "组合方案不存在" }, { status: 404 });
    }
    if (url.pathname === "/api/booking/run" && request.method === "POST")
      return json(await scheduler.runNow());
    if (url.pathname === "/api/runtime/status") return json(scheduler.status());
    if (url.pathname === "/api/runtime/next-target") {
      const now = new Date();
      const enabled = listPlanItems().find((item) => item.enabled);
      // 下一次「预约」= 下一个 20:00 锚点（后台真正动手的时刻）。
      const target = nextBookingAnchor(now);
      const booking = enabled
        ? {
            kind: "booking" as const,
            label: "预约",
            at: target.toLocaleString("zh-CN", { hour12: false, timeZone: timezone }),
            planId: enabled.id,
            time: target.getTime(),
          }
        : undefined;
      // 签到分支读调度器内存里的待签到集合，不再为了展示多打一次馆方接口。
      const pendingCheckIn = scheduler.autoCheckInEnabled ? scheduler.nextCheckIn() : undefined;
      const checkin = pendingCheckIn
        ? {
            kind: "check-in" as const,
            label: "签到",
            at: new Date(pendingCheckIn.at).toLocaleString("zh-CN", { hour12: false, timeZone: timezone }),
            bookingId: pendingCheckIn.bookingId,
            time: pendingCheckIn.at,
          }
        : undefined;
      const next = [booking, checkin]
        .filter(Boolean)
        .sort((a, b) => (a as { time: number }).time - (b as { time: number }).time)[0] as
        | typeof booking
        | typeof checkin
        | undefined;
      return json(
        next
          ? {
              kind: next.kind,
              label: next.label,
              at: next.at,
              planId: "planId" in next ? next.planId : undefined,
              bookingId: "bookingId" in next ? next.bookingId : undefined,
            }
          : { kind: "none", label: "暂无待执行任务" },
      );
    }
    if (url.pathname === "/api/checkin" && request.method === "GET")
      return json({
        enabled: scheduler.autoCheckInEnabled,
        consentVersion: scheduler.consentVersion,
        consentedAt: scheduler.consentedAt,
      });
    if (url.pathname === "/api/checkin/enable" && request.method === "POST") {
      const body = (await request.json()) as { agreed?: boolean };
      if (!body.agreed) return json({ detail: "启用自动签到需要确认风险协议" }, { status: 409 });
      scheduler.setAutoCheckIn(true, true);
      return json({
        enabled: true,
        consentVersion: scheduler.consentVersion,
        consentedAt: scheduler.consentedAt,
      });
    }
    if (url.pathname === "/api/checkin/disable" && request.method === "POST") {
      scheduler.setAutoCheckIn(false);
      return json({
        enabled: false,
        consentVersion: scheduler.consentVersion,
        consentedAt: scheduler.consentedAt,
      });
    }
    if (url.pathname === "/api/catalog/room-types" && request.method === "GET")
      return json({ options: await catalog.roomTypes(auth) });
    if (url.pathname === "/api/catalog/floors" && request.method === "GET")
      return json(
        await catalog.floors(
          auth,
          url.searchParams.get("roomQuery") || "",
          url.searchParams.get("roomType") || undefined,
        ),
      );
    if (url.pathname === "/api/catalog/durations" && request.method === "GET")
      return json(
        await catalog.durations(
          auth,
          url.searchParams.get("roomQuery") || "",
          Number(url.searchParams.get("startHour")),
          url.searchParams.get("roomType") || undefined,
        ),
      );
    const bookingMatch = url.pathname.match(
      /^\/api\/bookings\/([^/]+)\/(cancel|check-in|leave|renew|sign-out)$/,
    );
    if (bookingMatch) {
      const bookingId = decodeURIComponent(bookingMatch[1]);
      const action = bookingMatch[2];
      const kind =
        action === "check-in"
          ? "checkIn"
          : action === "renew"
            ? "comeBack"
            : action === "sign-out"
              ? "signOut"
              : action;
      await auth.client.action(kind as "cancel" | "checkIn" | "comeBack" | "leave" | "signOut", bookingId);
      // 手动动作后本地状态立即跟上，避免调度器再对同一单重复提交。
      if (action === "check-in") scheduler.noteCheckedIn(bookingId);
      else if (action === "cancel") scheduler.forget(bookingId);
      return json({ success: true, message: "操作成功" });
    }
    if (url.pathname === "/api/bookings/current" && request.method === "GET") {
      const raw = await auth.client.bookings();
      // 顺手把这份列表喂给调度器：签到同步零额外请求。
      scheduler.observeBookings(raw);
      const ended = new Set(["3", "4", "5", "6", "7", "9"]);
      const bookings = raw
        .filter((item) => !ended.has(String(item.status || "")))
        .map((item) => {
          const status = String(item.status || "");
          const begin = Number(item.time || 0) * 1000;
          const now = Number(item.nowTime || 0);
          const canCheckIn =
            status === "0" &&
            now >= Number(item.time || 0) - Number(item.limitSignAgo || 0) &&
            now <= Number(item.time || 0) + Number(item.limitSignBack || 0);
          return {
            bookingId: String(item.id || ""),
            roomName: String(item.roomName || "未知房间"),
            seatNum: String(item.seatNum || "-"),
            startText: begin ? new Date(begin).toLocaleString("zh-CN", { hour12: false }) : "未知时间",
            durationText: `${Number(item.duration || 0) / 3600 || 0} 小时`,
            status,
            state: canCheckIn ? "check_in" : status === "1" ? "in_use" : status === "2" ? "away" : "pending",
            statusLabel: canCheckIn
              ? "可签到"
              : status === "1"
                ? "使用中"
                : status === "2"
                  ? "暂离中"
                  : "待签到",
            canCancel: status === "0",
            canCheckIn,
            canSignOut: status === "1" || status === "2",
            canLeave: status === "1",
            canRenew: status === "2",
          };
        });
      return json({ bookings });
    }
    return json({ detail: "not found" }, { status: 404 });
  };
}
