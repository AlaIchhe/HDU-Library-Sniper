import { z } from "zod";
import type { AuditEvent, Booking, BookingPlan, BookingRange, CheckInStatus, DurationOptions, FloorOption, NextExecutionTarget, PlanListItem, RoomTypeOption, RuntimeStatus, SessionStatus } from "../shared/types";

export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "http://127.0.0.1:8000";
  return "";
}

const sessionSchema = z.object({ authenticated: z.boolean(), uid: z.string().optional(), name: z.string().optional(), refreshing: z.boolean(), lastError: z.string().optional() });
const checkinSchema = z.object({ enabled: z.boolean(), consentVersion: z.string(), consentedAt: z.string().optional(), lastAttemptAt: z.string().optional(), lastSuccessAt: z.string().optional(), lastMessage: z.string().optional() });

async function call<T>(path: string, init?: RequestInit, schema?: z.ZodType<T>): Promise<T> {
  const response = await fetch(`${resolveApiBase()}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const text = await response.text();
  let body: { detail?: string; message?: string } = {};
  if (text) {
    try { body = JSON.parse(text) as typeof body; }
    catch { throw new Error(response.ok ? "后台服务返回格式错误" : `请求失败 (${response.status})`); }
  }
  if (!response.ok) throw new Error(body.detail || body.message || `请求失败 (${response.status})`);
  return schema ? schema.parse(body) : body as T;
}

export const api = {
  session: () => call<SessionStatus>("/api/session", undefined, sessionSchema),
  login: (studentId: string, password: string) => call<{ success: boolean; message: string }>("/api/session/login", { method: "POST", body: JSON.stringify({ studentId, password }) }),
  logout: () => call<{ success: boolean }>("/api/session/logout", { method: "POST" }),
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
};

type BookingGroup = Extract<PlanListItem, { kind: "group" }>;
