import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"

import { Spinner } from "@/components/ui/spinner"
import { BackendUnavailableError, pingBackend } from "./api"
import { router } from "./routes/router"
import { initializeTheme } from "./store"
import { isTauri } from "./tauri"
import "./index.css"

// 打包后首次启动时，后台 exe 可能还在被 Windows Defender 扫描；
// 这时任何查询都会失败且（retry: 0）不会自动恢复。先把路由挂起，
// 等 /api/health 真正可用后再渲染，避免"接口没返回、重开才好"。
function StartupGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [slow, setSlow] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isTauri() || !import.meta.env.PROD) {
      setReady(true)
      return
    }
    let cancelled = false
    const started = Date.now()
    const check = async () => {
      if (await pingBackend()) {
        if (!cancelled) setReady(true)
        return
      }
      if (cancelled) return
      const waited = Date.now() - started
      if (waited > 30_000) setFailed(true)
      else if (waited > 8_000) setSlow(true)
      window.setTimeout(check, 400)
    }
    void check()
    return () => { cancelled = true }
  }, [])

  if (ready) return <>{children}</>
  return (
    <div className="grid min-h-svh place-items-center p-6">
      <div className="grid justify-items-center gap-3 text-center text-sm text-muted-foreground">
        <Spinner className="size-5" />
        <p>
          {failed
            ? "本地服务启动失败，请退出应用后重新打开"
            : slow
              ? "本地服务启动较慢（可能被杀毒软件扫描），正在重试…"
              : "正在启动本地服务…"}
        </p>
      </div>
    </div>
  )
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
