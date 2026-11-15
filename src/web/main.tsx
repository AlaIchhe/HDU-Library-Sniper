import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { isMyGo } from "mygo-runtime"

import { Spinner } from "@/ui/spinner"
import { router } from "./routes/router"
import { initializeTheme } from "./data/store"
import { DesktopAPI } from "./mygo"
import "./index.css"

// 桌面端启动时会异步初始化数据库与任务调度，这里只等待一次 DesktopAPI.ready()：
// 正常情况零轮询立即渲染，若底层初始化失败则直接展示错误。
function StartupGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!isMyGo())
  const [detail, setDetail] = useState<string | null>(null)

  useEffect(() => {
    if (ready) return
    let cancelled = false
    void (async () => {
      try {
        await DesktopAPI.ready()
        if (!cancelled) setReady(true)
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
        <p>
          {detail === null ? "正在初始化本地服务…" : "本地服务启动失败，请检查配置目录权限后重新打开应用"}
        </p>
        {detail !== null ? <p className="text-xs break-all text-destructive">{detail}</p> : null}
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <StartupGate>
        <RouterProvider router={router} />
      </StartupGate>
    </QueryClientProvider>
  </StrictMode>,
)
