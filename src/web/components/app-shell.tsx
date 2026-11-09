"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import {
  IconCalendarEvent,
  IconCalendarEventFilled,
  IconExternalLink,
  IconLibrary,
  IconListCheck,
  IconListCheckFilled,
  IconLogout,
  IconMoon,
  IconRefresh,
  IconSun,
} from "@tabler/icons-react"
import { AnimatedGridPattern } from "@/ui/animated-grid-pattern"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/ui/sidebar"
import { toastManager, ToastProvider } from "@/ui/toast"
import { useQueryClient } from "@tanstack/react-query"
import { useAppStore } from "../data/store"
import { queryKeys, useRuntime, useSession } from "../data/queries"
import { LightRays } from "@/ui/light-rays"
import { api } from "../data/api"
import { notifyAuditEvents } from "../platform/notifications"
import { openExternalUrl } from "../platform/tauri"
import { forgetReturnTo, rememberReturnTo } from "../return-to"
import { startUpdateCheck } from "../platform/updater"
import { CommandPalette } from "./command-palette"
import { cn } from "@/lib/utils"
import { useHotkeys } from "../hooks/use-hotkeys"
import { useNavMode } from "../hooks/use-nav-mode"
import { FloatingDock } from "./floating-dock"
import { HoverRail } from "./hover-rail"
import type { Command } from "../commands"

/** 统一的语义色状态点：颜色由 tone 决定，切换时用 spring 过渡而非硬切。 */
import { AppContent, AppHeader } from "./app-shell/header"
import { StatusDot } from "./app-shell/status"

export function AppShell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname as string,
  })
  const session = useAppStore((state) => state.session)
  const setSession = useAppStore((state) => state.setSession)
  // 深链接进来时登录页并不在，会话要由这里取一次，否则守卫永远是"未登录"。
  const sessionQuery = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const theme = useAppStore((state) => state.theme)
  const notice = useAppStore((state) => state.notice)
  const setNotice = useAppStore((state) => state.setNotice)
  const requestRefresh = useAppStore((state) => state.requestRefresh)
  const runtime = useRuntime()
  const navMode = useNavMode()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const authenticated = Boolean(session?.authenticated)

  // 开机静默查一次更新：只点亮顶栏控件，不下载、不弹提示。
  useEffect(() => {
    startUpdateCheck()
  }, [])
  useEffect(() => {
    if (!authenticated) return
    let active = true
    const poll = async () => {
      try {
        const result = await api.audit(50)
        if (active) await notifyAuditEvents(result.events)
      } catch {
        /* backend may not be ready yet */
      }
    }
    // 不轮询：登录后、窗口重新获得焦点/可见时检查一次新事件。
    const refresh = () => {
      if (document.visibilityState === "visible") void poll()
    }
    void poll()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      active = false
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [authenticated])

  // 后台任务结束（抢座/签到跑完）后刷新预约列表和“下一次执行”；平时不轮询。
  const lastRunAt = runtime.data?.lastRunAt
  const previousRunAt = useRef<string | undefined>(undefined)
  useEffect(() => {
    const previous = previousRunAt.current
    previousRunAt.current = lastRunAt
    if (!lastRunAt || previous === undefined || previous === lastRunAt) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.bookings })
    void queryClient.invalidateQueries({ queryKey: queryKeys.nextTarget })
  }, [lastRunAt, queryClient])

  // 只补种一次：登录成功后 store 里有新会话，不要被上一次查询的旧结果覆盖。
  useEffect(() => {
    if (!session && sessionQuery.data) setSession(sessionQuery.data)
  }, [session, sessionQuery.data, setSession])

  // 会话确认可用之前不跳转，否则深链接会先被弹回首页。
  // 判断用查询结果为准：store 里的会话要等一次 effect 才补种，晚一拍。
  useEffect(() => {
    if (!sessionQuery.isSuccess || sessionQuery.data?.authenticated || session?.authenticated) return
    if (pathname === "/") return
    rememberReturnTo(pathname)
    navigate({ to: "/", replace: true })
  }, [sessionQuery.isSuccess, sessionQuery.data?.authenticated, session?.authenticated, pathname, navigate])

  // 已经落在目标页，把"登录后返回"的记录清掉。
  useEffect(() => {
    if (authenticated && pathname !== "/") forgetReturnTo()
  }, [authenticated, pathname])

  useEffect(() => {
    if (!notice) return
    toastManager.add({
      type: notice.tone === "error" ? "error" : notice.tone === "warning" ? "warning" : "success",
      title: notice.message,
    })
    setNotice(null)
  }, [notice, setNotice])

  const logout = useCallback(async () => {
    try {
      await api.logout()
      // 清掉 session 查询缓存，避免登录页用陈旧缓存复活已登出的会话
      queryClient.removeQueries({ queryKey: queryKeys.session })
      setSession(null)
      navigate({ to: "/", replace: true })
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "退出登录失败",
      })
    }
  }, [navigate, queryClient, setSession])

  /** 刷新当前页：通过 store 广播，各页自行响应，不做 DOM 查询。 */
  const refreshCurrentPage = useCallback(() => {
    requestRefresh()
    void queryClient.invalidateQueries({ queryKey: queryKeys.nextTarget })
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtime })
  }, [queryClient, requestRefresh])

  useHotkeys(
    {
      "g p": () => void navigate({ to: "/plans" }),
      "g b": () => void navigate({ to: "/bookings" }),
      r: refreshCurrentPage,
    },
    { enabled: authenticated },
  )

  const commands: Command[] = [
    {
      id: "go-plans",
      label: "预约方案",
      group: "导航",
      icon: IconListCheck,
      keywords: ["plans", "yuyue", "fangan"],
      shortcut: "G P",
      run: () => void navigate({ to: "/plans" }),
    },
    {
      id: "go-bookings",
      label: "当前预约",
      group: "导航",
      icon: IconCalendarEvent,
      keywords: ["bookings", "dangqian"],
      shortcut: "G B",
      run: () => void navigate({ to: "/bookings" }),
    },
    {
      id: "refresh",
      label: "刷新当前页",
      group: "操作",
      icon: IconRefresh,
      keywords: ["refresh", "shuaxin"],
      shortcut: "R",
      run: refreshCurrentPage,
    },
    {
      id: "theme",
      label: theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
      group: "操作",
      icon: theme === "dark" ? IconSun : IconMoon,
      keywords: ["theme", "dark", "light", "zhuti", "shense", "qianse", "qiehuan", "huan"],
      run: () => useAppStore.getState().toggleTheme(),
    },
    {
      id: "changelog",
      label: "查看更新日志",
      group: "操作",
      icon: IconExternalLink,
      keywords: ["changelog", "release", "gengxin"],
      run: () => void openExternalUrl("https://github.com/AlaIchhe/HDU-Library-Sniper/releases"),
    },
    {
      id: "logout",
      label: "退出登录",
      group: "账户",
      icon: IconLogout,
      keywords: ["logout", "tuichu", "dengchu"],
      run: () => void logout(),
    },
  ]

  const errorState = runtime.data?.state === "error"
  const authRequired = runtime.data?.state === "auth_required"
  const plansActive = pathname === "/plans"
  const bookingsActive = pathname === "/bookings"

  return (
    <div className="relative min-h-dvh min-w-0 overflow-x-hidden text-foreground">
      <LightRays
        count={5}
        color="rgba(140, 180, 255, 0.12)"
        blur={28}
        speed={18}
        className="fixed inset-0 -z-10"
      />
      <AnimatedGridPattern
        numSquares={18}
        maxOpacity={0.06}
        className="fixed inset-0 -z-10 [mask-image:radial-gradient(ellipse_at_center,white,transparent_72%)]"
      />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />

      {pathname === "/" ? (
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      ) : (
        <ToastProvider>
          {navMode === "wide" ? (
            <SidebarProvider className="min-w-0">
              <Sidebar variant="inset">
                <SidebarHeader>
                  <div className="flex items-center gap-3 px-2 py-2">
                    <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg">
                      <IconLibrary className="size-5" />
                    </span>
                    <div className="group-data-[collapsible=icon]:hidden">
                      <strong className="block text-sm">HDU Sniper</strong>
                    </div>
                  </div>
                </SidebarHeader>
                <SidebarContent>
                  <SidebarGroup>
                    <SidebarGroupLabel>工作台</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            isActive={plansActive}
                            tooltip="预约方案（G P）"
                            className="transition-[width,height,padding,background-color,color,box-shadow,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-xs focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar data-[active=true]:shadow-xs"
                            render={<Link to="/plans" />}
                          >
                            {plansActive ? <IconListCheckFilled size={20} /> : <IconListCheck size={20} />}
                            预约方案
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            isActive={bookingsActive}
                            tooltip="当前预约（G B）"
                            className="transition-[width,height,padding,background-color,color,box-shadow,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-xs focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar data-[active=true]:shadow-xs"
                            render={<Link to="/bookings" />}
                          >
                            {bookingsActive ? (
                              <IconCalendarEventFilled size={20} />
                            ) : (
                              <IconCalendarEvent size={20} />
                            )}
                            当前预约
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>
                <SidebarFooter>
                  <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card/50 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2 text-xs">
                      <StatusDot
                        tone={errorState ? "bad" : authRequired ? "warn" : "ok"}
                        pulse={!errorState && !authRequired}
                      />
                      <span className="truncate text-muted-foreground">
                        {errorState ? "后台服务异常" : authRequired ? "需要重新登录" : "后台服务在线"}
                      </span>
                    </div>
                  </div>
                </SidebarFooter>
              </Sidebar>
              <SidebarInset className="min-w-0 max-w-full overflow-x-hidden">
                <AppHeader
                  sessionName={session?.name}
                  theme={theme}
                  runtimeState={runtime.data?.state}
                  showSidebarTrigger
                  onOpenPalette={() => setPaletteOpen(true)}
                  onLogout={logout}
                />
                <AppContent pathname={pathname} compact={false} />
              </SidebarInset>
            </SidebarProvider>
          ) : (
            <div
              className={cn(
                "relative flex min-h-dvh min-w-0 flex-col overflow-x-hidden bg-background",
                navMode === "medium" && "pl-16",
              )}
            >
              {navMode === "medium" ? (
                <HoverRail
                  plansActive={plansActive}
                  bookingsActive={bookingsActive}
                  runtimeState={runtime.data?.state}
                />
              ) : null}
              <AppHeader
                sessionName={session?.name}
                theme={theme}
                runtimeState={runtime.data?.state}
                showSidebarTrigger={false}
                onOpenPalette={() => setPaletteOpen(true)}
                onLogout={logout}
              />
              <AppContent pathname={pathname} compact={navMode === "compact"} />
              {navMode === "compact" ? (
                <FloatingDock plansActive={plansActive} bookingsActive={bookingsActive} />
              ) : null}
            </div>
          )}
        </ToastProvider>
      )}
    </div>
  )
}
