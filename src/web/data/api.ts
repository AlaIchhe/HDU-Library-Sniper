import {
  API_ENUMS,
  API_ROUTES,
  API_SCHEMAS,
  type APIEndpoints,
  type BookingAction,
  type ErrorResponse,
  type PlanToggleAction,
  type PlanUpsertRequest,
  type SchemaField,
  type SchemaNode,
} from "../../shared/api.generated"

let desktopBaseUrl = ""
let desktopToken = ""
let onUnauthorizedHandler: (() => void) | null = null

export function setDesktopTransport(baseUrl: string, token: string) {
  desktopBaseUrl = baseUrl.replace(/\/+$/, "")
  desktopToken = token
}

export function getDesktopToken(): string {
  return desktopToken
}

export function setOnUnauthorized(handler: (() => void) | null) {
  onUnauthorizedHandler = handler
}

export function resolveApiBase(): string {
  if (desktopBaseUrl) return desktopBaseUrl
  const configured = import.meta.env.VITE_API_BASE?.trim()
  return configured ? configured.replace(/\/+$/, "") : ""
}

function matchesNode(value: unknown, node: SchemaNode): boolean {
  switch (node.kind) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "boolean":
      return typeof value === "boolean"
    case "record":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "unknown":
      return true
    case "enum":
      return (API_ENUMS[node.name] as readonly unknown[]).includes(value)
    case "array":
      return Array.isArray(value) && value.every((item) => matchesNode(item, node.item))
    case "ref":
      return matchesObject(value, API_SCHEMAS[node.name])
  }
}

function matchesObject(value: unknown, schema: Record<string, SchemaField>): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  for (const [key, field] of Object.entries(schema)) {
    const fieldVal = record[key]
    if (fieldVal === undefined) {
      if (!field.optional) return false
      continue
    }
    if (!matchesNode(fieldVal, field)) return false
  }
  return true
}

function assertContract<T>(value: unknown, schema: Record<string, SchemaField>): T {
  if (!matchesObject(value, schema)) {
    throw new Error("后台服务返回格式错误")
  }
  return value as T
}

export function buildPath(
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

export function buildEventUrl(pattern: string, pathParams?: Record<string, string | number>): string {
  const query = desktopToken ? { token: desktopToken } : undefined
  return `${resolveApiBase()}${buildPath(pattern, pathParams, query)}`
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

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (desktopToken) {
    headers.Authorization = `Bearer ${desktopToken}`
  }

  let response: Response
  let text: string
  try {
    response = await fetch(`${resolveApiBase()}${path}`, {
      method: route.method,
      body: payload,
      headers,
      credentials: "include",
    })
    text = await response.text()
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    throw new Error("无法连接本地后台服务，请确认服务已启动")
  }

  let parsed: unknown
  if (text) {
    try {
      parsed = JSON.parse(text)
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
    if (response.status === 401 && endpoint !== "panelAuthLogin") {
      onUnauthorizedHandler?.()
      throw new Error(errBody.detail || "登录已过期，请重新登录")
    }
    throw new Error(errBody.detail || errBody.message || `请求失败 (${response.status})`)
  }

  return assertContract<APIEndpoints[K]["response"]>(parsed, API_SCHEMAS[route.schema])
}

export const api = {
  panelAuthStatus: () => request("panelAuthStatus"),
  panelAuthLogin: (password: string) => request("panelAuthLogin", { body: { password } }),
  session: () => request("sessionStatus"),
  login: (studentId: string, password: string) => request("sessionLogin", { body: { studentId, password } }),
  openidLogin: (openid: string) => request("sessionOpenId", { body: { openid } }),
  logout: () => request("sessionLogout"),
  qrStart: () => request("sessionQrStart"),
  qrStatus: (uuid: string) => request("sessionQrStatus", { path: { uuid } }),
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
