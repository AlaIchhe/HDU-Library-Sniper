import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/api/session", () => HttpResponse.json({ authenticated: false, refreshing: false })),
  http.post("/api/session/login", () => HttpResponse.json({ success: true, message: "认证成功" })),
  http.get("/api/plans", () => HttpResponse.json({ plans: [] })),
  http.get("/api/bookings/current", () => HttpResponse.json({ bookings: [] })),
  http.get("/api/checkin", () => HttpResponse.json({ enabled: false, consentVersion: "2026-01" })),
  http.get("/api/runtime/status", () => HttpResponse.json({ scheduler: "running", state: "idle" })),
  http.get("/api/runtime/next-target", () => HttpResponse.json({ kind: "none", label: "暂无待执行任务" })),
  http.get("/api/catalog/room-types", () => HttpResponse.json({ options: [] })),
];
