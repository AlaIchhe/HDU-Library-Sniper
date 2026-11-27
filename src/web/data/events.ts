import { API_ROUTES, type AppEvent, type QrStatusEvent, type SessionStatus } from "../../shared/api.generated"
import { api, buildEventUrl } from "./api"

export type AppEventHandlers = {
  onEvent: (event: AppEvent) => void
  onSessionExpired?: (session: SessionStatus) => void
  onReconnect?: () => void
}

export type QrEventHandlers = {
  onEvent: (event: QrStatusEvent) => void
  onError?: (message: string) => void
}

function parseJsonEvent<T>(message: Event): T | null {
  const raw = (message as { data?: unknown }).data
  if (typeof raw !== "string") return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function subscribeAppEvents(handlers: AppEventHandlers): () => void {
  if (typeof EventSource === "undefined") {
    return () => {}
  }

  const url = buildEventUrl(API_ROUTES.events.pattern)
  let closed = false
  let source: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  let hadError = false
  let probing = false
  let backoffMs = 2000

  const clearTimers = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    if (probeTimer !== undefined) {
      clearTimeout(probeTimer)
      probeTimer = undefined
    }
  }

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return
    const delay = backoffMs
    backoffMs = Math.min(backoffMs * 2, 15_000)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  const probeSession = async () => {
    if (closed || probing) return
    probing = true
    try {
      const sess = await api.session()
      if (closed) return
      if (!sess.authenticated) {
        closed = true
        clearTimers()
        source?.close()
        source = null
        handlers.onSessionExpired?.(sess)
        return
      }
      if (source?.readyState === EventSource.CLOSED) {
        source.close()
        source = null
        scheduleReconnect()
      }
    } catch {
      if (!closed && source?.readyState === EventSource.CLOSED) {
        scheduleReconnect()
      }
    } finally {
      probing = false
    }
  }

  const connect = () => {
    if (closed) return
    source?.close()
    const es = new EventSource(url, { withCredentials: true })
    source = es

    es.addEventListener("open", () => {
      if (closed) return
      backoffMs = 2000
      if (hadError) {
        hadError = false
        handlers.onReconnect?.()
      }
    })

    es.addEventListener("app_event", (message) => {
      if (closed) return
      const parsed = parseJsonEvent<AppEvent>(message)
      if (parsed && typeof parsed.kind === "string") {
        handlers.onEvent(parsed)
      }
    })

    es.addEventListener("error", () => {
      if (closed) return
      hadError = true
      if (probeTimer !== undefined) return
      probeTimer = setTimeout(() => {
        probeTimer = undefined
        void probeSession()
      }, 300)
    })
  }

  connect()

  return () => {
    closed = true
    clearTimers()
    source?.close()
    source = null
  }
}

export function subscribeQrEvents(uuid: string, handlers: QrEventHandlers): () => void {
  if (typeof EventSource === "undefined") {
    return () => {}
  }

  const url = buildEventUrl(API_ROUTES.sessionQrEvents.pattern, { uuid })
  let closed = false
  let source: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let probing = false
  let reconnectAttempts = 0

  const cleanup = () => {
    closed = true
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    source?.close()
    source = null
  }

  const emit = (ev: QrStatusEvent) => {
    if (closed || ev.uuid !== uuid) return
    if (ev.status !== "pending") {
      cleanup()
    }
    handlers.onEvent(ev)
  }

  const scheduleOrFail = (message: string) => {
    if (closed) return
    reconnectAttempts += 1
    if (reconnectAttempts > 5) {
      cleanup()
      handlers.onError?.(message)
      return
    }
    if (source?.readyState === EventSource.CLOSED && retryTimer === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        connect()
      }, 1500)
    }
  }

  const probeOrRetry = async () => {
    if (closed || probing) return
    probing = true
    try {
      const st = await api.qrStatus(uuid)
      if (closed) return
      if (st.status !== "pending") {
        emit({ uuid, ...st })
        return
      }
      scheduleOrFail("扫码状态连接中断，请刷新二维码")
    } catch {
      scheduleOrFail("扫码状态连接失败，请刷新二维码")
    } finally {
      probing = false
    }
  }

  const connect = () => {
    if (closed) return
    source?.close()
    const es = new EventSource(url, { withCredentials: true })
    source = es

    es.addEventListener("open", () => {
      reconnectAttempts = 0
    })

    es.addEventListener("qr_status", (message) => {
      if (closed) return
      reconnectAttempts = 0
      const parsed = parseJsonEvent<QrStatusEvent>(message)
      if (parsed && typeof parsed.uuid === "string" && typeof parsed.status === "string") {
        emit(parsed)
      }
    })

    es.addEventListener("error", () => {
      if (closed || retryTimer !== undefined) return
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void probeOrRetry()
      }, 500)
    })
  }

  connect()
  return cleanup
}
