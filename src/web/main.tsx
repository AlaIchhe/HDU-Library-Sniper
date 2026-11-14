import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"

import { Spinner } from "@/ui/spinner"
import { router } from "./routes/router"
import { initializeTheme } from "./data/store"
import { isTauri } from "./platform/tauri"
import "./index.css"

// 桌面端在 Rust setup() 阶段已同步完成初始化，这里只做一次状态确认：
// 正常情况零轮询立即渲染，若数据库等初始化失败则直接展示底层报错。
function StartupGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!isTauri() || !import.meta.env.PROD)
  const [detail, setDetail] = useState<string | null>(null)

  useEffect(() => {
    if (ready) return
    let cancelled = false
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core")
        const status = await invoke<{ running: boolean; error?: string | null }>("local_api_status")
        if (cancelled) return
        if (status.running) {
          setReady(true)
        } else {
          setDetail(status.error || "本地服务未能初始化")
        }
      } catch (cause) {
        if (!cancelled) {
          setDetail(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready])

  if (ready) return <>{children}</>
  return (
    <div className="grid min-h-svh place-items-center p-6">
      <div className="grid max-w-[36rem] justify-items-center gap-3 text-center text-sm text-muted-foreground">
        {detail === null ? <Spinner className="size-5" /> : null}
        <p>{detail === null ? "正在初始化本地服务…" : "本地服务启动失败，请查看日志后重新打开应用"}</p>
        {detail !== null ? <p className="text-xs break-all text-destructive">{detail}</p> : null}
        {detail !== null ? (
          <p className="text-xs">日志：%LOCALAPPDATA%\io.github.alaichhe.hdu-library-sniper\logs</p>
        ) : null}
      </div>
    </div>
  )
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // 默认不重试馆方错误，避免放大上游 502。
      retry: false,
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
