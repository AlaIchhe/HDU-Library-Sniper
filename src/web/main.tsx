import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"

import { Spinner } from "@/ui/spinner"
import { BackendUnavailableError, pingBackend } from "./data/api"
import { router } from "./routes/router"
import { initializeTheme } from "./data/store"
import { isTauri } from "./platform/tauri"
import "./index.css"

// 首次启动时后端可能还在初始化：先把路由挂起，等 /api/health 真正可用后再渲染。
// 探针带超时；失败时把实际原因（HTTP 状态 / 连接错误 / Rust 侧的 bind 失败）
// 显示出来并写进日志，避免只有一句“请退出应用后重新打开”。
function StartupGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [slow, setSlow] = useState(false)
  const [failed, setFailed] = useState(false)
  const [detail, setDetail] = useState("")

  useEffect(() => {
    if (!isTauri() || !import.meta.env.PROD) {
      setReady(true)
      return
    }
    let cancelled = false
    let reported = false
    const started = Date.now()
    const check = async () => {
      const probe = await pingBackend()
      if (probe.ok) {
        if (!cancelled) setReady(true)
        return
      }
      if (cancelled) return
      const waited = Date.now() - started
      if (waited > 30_000) {
        setFailed(true)
        if (!reported) {
          reported = true
          setDetail(probe.detail)
          // 后端起不来时把 Rust 侧记录的原因带上（端口被占用、数据库打不开等）。
          void backendStartupError().then((error) => {
            if (!cancelled && error) setDetail(`${error}（探测：${probe.detail}）`)
          })
          void import("@tauri-apps/plugin-log")
            .then(({ error }) => error(`本地服务启动失败: ${probe.detail}`))
            .catch(() => undefined)
        }
      } else if (waited > 8_000) {
        setSlow(true)
      }
      window.setTimeout(check, 400)
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [])

  if (ready) return <>{children}</>
  return (
    <div className="grid min-h-svh place-items-center p-6">
      <div className="grid max-w-[36rem] justify-items-center gap-3 text-center text-sm text-muted-foreground">
        <Spinner className="size-5" />
        <p>
          {failed
            ? "本地服务启动失败，请查看日志后重新打开应用"
            : slow
              ? "本地服务启动较慢，正在重试…"
              : "正在启动本地服务…"}
        </p>
        {failed ? <p className="text-xs break-all text-destructive">{detail}</p> : null}
        {failed ? (
          <p className="text-xs">日志：%LOCALAPPDATA%\io.github.alaichhe.hdu-library-sniper\logs</p>
        ) : null}
      </div>
    </div>
  )
}

async function backendStartupError(): Promise<string | undefined> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const status = await invoke<{ running: boolean; error?: string | null }>("local_api_status")
    return status.error || undefined
  } catch {
    return undefined
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // 默认不重试馆方错误（避免放大 502），但本地后台正在启动/重启时可以自动重试。
      retry: (failureCount, error) => error instanceof BackendUnavailableError && failureCount < 4,
      retryDelay: 700,
    },
  },
})

initializeTheme()

if (isTauri()) {
  // 把 Rust 侧日志转发到 WebView 控制台，方便排查打包环境问题
  void import("@tauri-apps/plugin-log").then(({ attachConsole }) => attachConsole()).catch(() => undefined)
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <StartupGate>
        <RouterProvider router={router} />
      </StartupGate>
    </QueryClientProvider>
  </StrictMode>,
)
