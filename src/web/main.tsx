import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { isMyGo } from "mygo-runtime"

import { Button } from "@/ui/button"
import { Card } from "@/ui/card"
import { Field, FieldLabel, FormError } from "@/ui/field"
import { Input } from "@/ui/input"
import { Spinner } from "@/ui/spinner"
import { api, setDesktopTransport, setOnUnauthorized } from "./data/api"
import { queryKeys } from "./data/queries"
import { initializeTheme } from "./data/store"
import { DesktopAPI } from "./mygo"
import { router } from "./routes/router"
import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import "./index.css"

function StartupGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!isMyGo())
  const [detail, setDetail] = useState<string | null>(null)
  const [panelLocked, setPanelLocked] = useState(false)
  const [password, setPassword] = useState("")
  const [authError, setAuthError] = useState("")
  const [unlocking, setUnlocking] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (isMyGo()) {
          const cfg = await DesktopAPI.config()
          if (cancelled) return
          setDesktopTransport(cfg.baseUrl, cfg.token)
        } else {
          const status = await api.panelAuthStatus()
          if (cancelled) return
          if (status.required && !status.authenticated) {
            setPanelLocked(true)
          }
        }
        setReady(true)
      } catch (cause) {
        if (!cancelled) {
          setDetail(cause instanceof Error ? cause.message : String(cause))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function unlockPanel(e: FormEvent) {
    e.preventDefault()
    if (!password.trim()) {
      setAuthError("请输入访问密码")
      return
    }
    setUnlocking(true)
    setAuthError("")
    try {
      await api.panelAuthLogin(password.trim())
      setPanelLocked(false)
      setPassword("")
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "访问密码错误")
    } finally {
      setUnlocking(false)
    }
  }

  if (!ready) {
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

  if (panelLocked) {
    return (
      <div className="grid min-h-svh place-items-center p-6">
        <Card className="w-full max-w-sm p-6">
          <form onSubmit={(e) => void unlockPanel(e)} className="grid gap-4">
            <div>
              <h1 className="text-base font-semibold">访问验证</h1>
              <p className="mt-1 text-xs text-muted-foreground">该面板已启用访问保护，请输入访问密码。</p>
            </div>
            <Field>
              <FieldLabel>访问密码</FieldLabel>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              {authError ? <FormError>{authError}</FormError> : null}
            </Field>
            <Button type="submit" loading={unlocking}>
              解锁面板
            </Button>
          </form>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: false,
    },
  },
})

setOnUnauthorized(() => {
  queryClient.setQueryData(queryKeys.session, { authenticated: false, refreshing: false })
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
