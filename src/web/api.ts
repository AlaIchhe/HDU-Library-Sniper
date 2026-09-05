import { z } from "zod";
import { isTauri } from "./tauri";
import { useAppStore } from "./store";
import type {
  AuditEvent,
  Booking,
  BookingPlan,
  BookingRange,
  CheckInStatus,
  ClashDirectStatus,
  DurationOptions,
  FloorOption,
  NextExecutionTarget,
  PlanListItem,
  QrLoginStart,
  QrLoginStatus,
  RoomTypeOption,
  RuntimeStatus,
  SessionStatus,
} from "../shared/types";

export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window === "undefined") return "";
  if ("__TAURI_INTERNALS__" in window) return "http://127.0.0.1:8000";
  if (window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost" || window.location.hostname === "asset.localhost") return "http://127.0.0.1:8000";
  return "";
}

const sessionSchema = z.object({ authenticated: z.boolean(), uid: z.string().optional(), name: z.string().optional(), refreshing: z.boolean(), lastError: z.string().optional() });
const checkinSchema = z.object({ enabled: z.boolean(), consentVersion: z.string(), consentedAt: z.string().optional(), lastAttemptAt: z.string().optional(), lastSuccessAt: z.string().optional(), lastMessage: z.string().optional() });

async function call<T>(path: string, init?: RequestInit, schema?: z.ZodType<T>): Promise<T> {
  const base = resolveApiBase();
  const url = `${base}${path}`;
  let response: Response;
  try {
    const fetcher = isTauri()
      ? (await import("@tauri-apps/plugin-http")).fetch
      : globalThis.fetch.bind(globalThis);
    response = await fetcher(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    if (isTauri()) {
      const { error } = await import("@tauri-apps/plugin-log");
      error(`API 请求失败: ${url} -> ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    throw new Error("无法连接本地后台服务，请确认服务已启动");
  }

  const text = await response.text();
  let body: { detail?: string; message?: string } = {};
  if (text) {
    try { body = JSON.parse(text) as typeof body; }
    catch { throw new Error(response.ok ? "后台服务返回格式错误" : `请求失败 (${response.status})`); }
  }
  if (!response.ok) {
    if (isTauri()) {
      const { error, warn } = await import("@tauri-apps/plugin-log");
      const message = `API 返回错误: ${url} -> ${response.status}`;
      if (response.status >= 500) error(message);
      else warn(message);
    }
    if (response.status === 401) {
      // 后台服务重启会丢失内存会话；清掉本地状态让轮询停下并回到登录页
      useAppStore.getState().setSession(null);
      throw new Error("登录已过期，请重新登录");
    }
    throw new Error(body.detail || body.message || `请求失败 (${response.status})`);
  }
  return schema ? schema.parse(body) : body as T;
}

export const api = {
  session: () => call<SessionStatus>("/api/session", undefined, sessionSchema),
  login: (studentId: string, password: string) => call<{ success: boolean; message: string }>("/api/session/login", { method: "POST", body: JSON.stringify({ studentId, password }) }),
  logout: () => call<{ success: boolean }>("/api/session/logout", { method: "POST" }),
  qrStart: () => call<QrLoginStart>("/api/session/qr", { method: "POST" }),
  qrStatus: (uuid: string) => call<QrLoginStatus>(`/api/session/qr/${encodeURIComponent(uuid)}/status`),
  plans: () => call<{ plans: PlanListItem[] }>("/api/plans"),
  createPlan: (plan: Partial<BookingPlan>) => call<{ plan: BookingPlan }>("/api/plans", { method: "POST", body: JSON.stringify(plan) }),
  setEnabled: (id: string, enabled: boolean) => call<{ plan: PlanListItem; disabledPlanIds: string[] }>(`/api/plans/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
  deletePlan: (id: string) => call<{ success: boolean }>(`/api/plans/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updatePlan: (id: string, patch: Partial<BookingPlan>) => call<{ plan: BookingPlan }>(`/api/plans/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  bookings: () => call<{ bookings: Booking[] }>("/api/bookings/current"),
  runtime: () => call<RuntimeStatus>("/api/runtime/status"),
  bookingAction: (id: string, action: string) => call<{ success: boolean; message: string }>(`/api/bookings/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
  nextTarget: () => call<NextExecutionTarget>("/api/runtime/next-target"),
  createGroup: (name: string, memberPlanIds: string[]) => call<{ plan: BookingGroup }>(
    "/api/groups", { method: "POST", body: JSON.stringify({ name, memberPlanIds }) }),
  updateGroup: (id: string, name: string, memberPlanIds: string[]) => call<{ plan: BookingGroup }>(
    `/api/groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name, memberPlanIds }) }),
  roomTypes: () => call<{ options: RoomTypeOption[] }>("/api/catalog/room-types"),
  floors: (roomQuery: string, roomType?: string) => call<{ options: FloorOption[]; range?: BookingRange }>(`/api/catalog/floors?roomQuery=${encodeURIComponent(roomQuery)}&roomType=${encodeURIComponent(roomType || "")}`),
  durations: (roomQuery: string, startHour: number, roomType?: string) => call<DurationOptions>(`/api/catalog/durations?roomQuery=${encodeURIComponent(roomQuery)}&roomType=${encodeURIComponent(roomType || "")}&startHour=${startHour}`),
  audit: (limit = 20) => call<{ events: AuditEvent[] }>(`/api/audit?limit=${limit}`),
  checkinStatus: () => call<CheckInStatus>("/api/checkin", undefined, checkinSchema),
  setCheckin: (enabled: boolean, agreed = false) => call<CheckInStatus>(`/api/checkin/${enabled ? "enable" : "disable"}`, { method: "POST", body: JSON.stringify({ agreed }) }, checkinSchema),
  clashDirectStatus: () => call<ClashDirectStatus>("/api/clash/direct"),
  setClashDirect: (enabled: boolean) => call<ClashDirectStatus>("/api/clash/direct", { method: "POST", body: JSON.stringify({ enabled }) }),
};

type BookingGroup = Extract<PlanListItem, { kind: "group" }>;
