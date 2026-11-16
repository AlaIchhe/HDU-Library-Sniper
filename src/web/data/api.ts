import { isMyGo } from "mygo-runtime"
import {
  API_ROUTES,
  API_SCHEMAS,
  type APIEndpoints,
  type BookingAction,
  type ErrorResponse,
  type GroupUpsertRequest,
  type PlanToggleAction,
  type PlanUpsertRequest,
} from "../../shared/api.generated"
import { DesktopAPI } from "../mygo"
import { useAppStore } from "./store"

export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE?.trim()
  return configured ? configured.replace(/\/+$/, "") : ""
}

type SchemaSpec = Record<string, string>

function matchesField(value: unknown, code: string): boolean {
  const optional = code.endsWith("?")
  if (value === undefined) return optional
  const kind = optional ? code.slice(0, -1) : code
  if (kind === "s") return typeof value === "string"
  if (kind === "n") return typeof value === "number" && Number.isFinite(value)
  if (kind === "b") return typeof value === "boolean"
  if (kind === "a") return Array.isArray(value)
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertContract<T>(value: unknown, schema: SchemaSpec): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("后台服务返回格式错误")
  }
  const record = value as Record<string, unknown>
  for (const [key, code] of Object.entries(schema)) {
    if (!matchesField(record[key], code)) throw new Error("后台服务返回格式错误")
  }
  return value as T
}

function buildPath(
  pattern: string,
  pathParams?: Record<string, string | number>,
  query?: Record<string, string | number | undefined>,
): string {
  const resolved = pathParams
    ? pattern.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(pathParams[key] ?? "")))
    : pattern
  if (!query) return resolved
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${resolved}?${qs}` : resolved
}

type RawResponse = {
  status: number
  ok: boolean
  text: string
}

async function sendRequest(method: string, path: string, body?: string): Promise<RawResponse> {
  if (isMyGo()) {
    const response = await DesktopAPI.request(method, path, body ?? "")
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text: response.body,
    }
  }
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method,
    body,
    headers: { "Content-Type": "application/json" },
  })
  return {
    status: response.status,
    ok: response.ok,
    text: await response.text(),
  }
}

type HasRequiredOptions<K extends keyof APIEndpoints> = APIEndpoints[K] extends { pathParams: unknown }
  ? true
  : APIEndpoints[K] extends { request: unknown }
    ? true
    : APIEndpoints[K] extends { query: unknown }
      ? undefined extends APIEndpoints[K]["query"]
        ? false
        : true
      : false

type CallOptions<K extends keyof APIEndpoints> = (APIEndpoints[K] extends { pathParams: infer P }
  ? { path: P }
  : { path?: never }) &
  (APIEndpoints[K] extends { query: infer Q }
    ? { query: Q }
    : APIEndpoints[K] extends { query?: infer Q }
      ? { query?: Q }
      : { query?: never }) &
  (APIEndpoints[K] extends { request: infer B } ? { body: B } : { body?: never })

async function request<K extends keyof APIEndpoints>(
  endpoint: K,
  ...args: HasRequiredOptions<K> extends true ? [options: CallOptions<K>] : [options?: CallOptions<K>]
): Promise<APIEndpoints[K]["response"]> {
  const route = API_ROUTES[endpoint]
  const options = args[0] as
    | {
        path?: Record<string, string | number>
        query?: Record<string, string | number | undefined>
        body?: unknown
      }
    | undefined
  const path = buildPath(route.pattern, options?.path, options?.query)
  const payload = options?.body !== undefined ? JSON.stringify(options.body) : undefined

  let response: RawResponse
  try {
    response = await sendRequest(route.method, path, payload)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    const detail = cause instanceof Error ? cause.message : String(cause)
    if (isMyGo()) console.error(`API 请求失败: ${path} -> ${detail}`)
    throw new Error(isMyGo() ? `本地服务不可用：${detail}` : "无法连接本地后台服务，请确认服务已启动")
  }

  let parsed: unknown
  if (response.text) {
    try {
      parsed = JSON.parse(response.text)
    } catch {
      throw new Error(response.ok ? "后台服务返回格式错误" : `请求失败 (${response.status})`)
    }
  }

  if (!response.ok) {
    const errBody = (
      typeof parsed === "object" && parsed !== null ? parsed : {}
    ) as Partial<ErrorResponse> & {
      message?: string
    }
    if (isMyGo()) {
      const detail = errBody.detail || errBody.message
      const message = `API 返回错误: ${path} -> ${response.status}${detail ? ` (${detail})` : ""}`
      if (response.status >= 500) console.error(message)
      else console.warn(message)
    }
    if (response.status === 401) {
      // 后台服务重启会丢失内存会话；清掉本地状态让轮询停下并回到登录页
      useAppStore.getState().setSession(null)
      throw new Error("登录已过期，请重新登录")
    }
    throw new Error(errBody.detail || errBody.message || `请求失败 (${response.status})`)
  }

  return assertContract<APIEndpoints[K]["response"]>(parsed, API_SCHEMAS[route.schema])
}

export const api = {
  session: () => request("sessionStatus"),
  login: (studentId: string, password: string) => request("sessionLogin", { body: { studentId, password } }),
  openidLogin: (openid: string) => request("sessionOpenId", { body: { openid } }),
  logout: () => request("sessionLogout"),
  qrStart: () => request("sessionQrStart"),
  qrStatus: (uuid: string) => request("sessionQrStatus", { path: { uuid } }),
  // 离开扫码页时让服务端停掉这个二维码的 SSO 轮询，避免它继续换掉登录会话。
  cancelQr: (uuid: string) => request("sessionQrCancel", { path: { uuid } }),
  plans: () => request("plansList"),
  createPlan: (plan: PlanUpsertRequest) => request("plansCreate", { body: plan }),
  setEnabled: (id: string, enabled: boolean) => {
    const action: PlanToggleAction = enabled ? "enable" : "disable"
    return request("plansToggle", { path: { id, action } })
  },
  deletePlan: (id: string) => request("plansDelete", { path: { id } }),
  updatePlan: (id: string, patch: PlanUpsertRequest) => request("plansUpdate", { path: { id }, body: patch }),
  bookings: () => request("bookingsCurrent"),
  runtime: () => request("runtimeStatus"),
  bookingAction: (id: string, action: BookingAction) => request("bookingsAction", { path: { id, action } }),
  nextTarget: () => request("runtimeNextTarget"),
  createGroup: (name: GroupUpsertRequest["name"], memberPlanIds: GroupUpsertRequest["memberPlanIds"]) =>
    request("groupsCreate", { body: { name, memberPlanIds } }),
  updateGroup: (
    id: string,
    name: GroupUpsertRequest["name"],
    memberPlanIds: GroupUpsertRequest["memberPlanIds"],
  ) => request("groupsUpdate", { path: { id }, body: { name, memberPlanIds } }),
  roomTypes: () => request("catalogRoomTypes"),
  floors: (roomQuery: string, roomType?: string) =>
    request("catalogFloors", { query: { roomQuery, roomType } }),
  durations: (roomQuery: string, startHour: number, roomType?: string) =>
    request("catalogDurations", { query: { roomQuery, startHour, roomType } }),
  audit: (limit = 20) => request("auditList", { query: { limit } }),
  checkinStatus: () => request("checkinStatus"),
  setCheckin: (enabled: boolean, agreed = false) =>
    enabled ? request("checkinEnable", { body: { agreed } }) : request("checkinDisable"),
}
