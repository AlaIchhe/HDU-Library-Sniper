"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { MotionConfig } from "motion/react"

import {
  AnimateIcon,
  CalendarDays,
  ExternalLink,
  LibraryBig,
  ListChecks,
  LogOut,
  Moon,
  RefreshCw,
  Sun,
} from "@/ui/icons"
import { ClickSpark } from "@/ui/click-spark"
import { fireSideCannons } from "@/ui/confetti"
import { DecryptedText } from "@/ui/decrypted-text"
import { MagicCard } from "@/ui/magic-card"
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
import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import type { InvalidateTarget, Notification, SessionStatus } from "../../shared/types"
import { useAppStore } from "../data/store"
import { queryKeys, useRuntime, useSession } from "../data/queries"
import { api } from "../data/api"
import { subscribeAppEvents } from "../data/events"
import { forgetReturnTo, rememberReturnTo } from "../return-to"
import { CommandPalette } from "./command-palette"
import { cn } from "@/lib/utils"
import { useHotkeys } from "../hooks/use-hotkeys"
import { useNavMode } from "../hooks/use-nav-mode"
import { FloatingDock } from "./floating-dock"
import { HoverRail } from "./hover-rail"
import type { Command } from "../commands"

import { Ambient } from "./app-shell/ambient"
import { AppContent, AppHeader } from "./app-shell/header"
import { StatusDot } from "./app-shell/status"

const INVALIDATE_KEYS: Record<InvalidateTarget, readonly unknown[]> = {
  plans: queryKeys.plans,
  bookings: queryKeys.bookings,
  nextTarget: queryKeys.nextTarget,
  checkin: queryKeys.checkin,
  runtime: queryKeys.runtime,
}

function applyInvalidateTargets(queryClient: QueryClient, targets: readonly InvalidateTarget[]) {
  for (const target of new Set(targets)) {
    const queryKey = INVALIDATE_KEYS[target]
    if (queryKey) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
}

function showNotificationToast(notif: Notification) {
  if (notif.celebrate) fireSideCannons()
  toastManager.add({
    type: notif.level,
    title: notif.title,
    description: notif.body || undefined,
  })
}

export function AppShell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname as string,
  })
  const sessionQuery = useSession()
  const session = sessionQuery.data ?? null
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const theme = useAppStore((state) => state.theme)
  const runtime = useRuntime()
  const navMode = useNavMode()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const authenticated = Boolean(session?.authenticated)

  const wasAuthenticated = useRef(false)

  useEffect(() => {
    if (session?.authenticated) {
      wasAuthenticated.current = true
    }
  }, [session?.authenticated])

  // 会话确认可用之前不跳转，否则深链接会先被弹回首页；已登录后若因 401/事件失活则跳回登录页。
  useEffect(() => {
    if (session?.authenticated) return
    if (!wasAuthenticated.current && (!sessionQuery.isSuccess || sessionQuery.data?.authenticated)) {
      return
    }
    wasAuthenticated.current = false
    if (pathname === "/") return
    rememberReturnTo(pathname)
    navigate({ to: "/", replace: true })
  }, [session?.authenticated, sessionQuery.isSuccess, sessionQuery.data?.authenticated, pathname, navigate])

  // 已经落在目标页，把"登录后返回"的记录清掉。
  useEffect(() => {
    if (authenticated && pathname !== "/") forgetReturnTo()
  }, [authenticated, pathname])

  // 订阅后端实时事件：Web 与桌面端统一走 SSE。
  useEffect(() => {
    if (!authenticated) return
    return subscribeAppEvents({
      onEvent: (event) => {
        if (event.kind === "session" && event.session) {
          const prevAuth = Boolean(queryClient.getQueryData<SessionStatus>(queryKeys.session)?.authenticated)
          queryClient.setQueryData(queryKeys.session, event.session)
          if (!event.session.authenticated && prevAuth && event.session.lastError) {
            toastManager.add({ type: "warning", title: event.session.lastError })
          }
          if (event.session.authenticated && !prevAuth) {
            applyInvalidateTargets(queryClient, ["plans", "bookings", "nextTarget", "checkin", "runtime"])
          }
        }
        if (event.kind === "runtime" && event.runtime) {
          queryClient.setQueryData(queryKeys.runtime, event.runtime)
        }
        if (event.invalidate?.length) {
          applyInvalidateTargets(queryClient, event.invalidate)
        }
        if (event.kind === "notification" && event.notification) {
          showNotificationToast(event.notification)
        }
      },
      onSessionExpired: (sess) => {
        const prevAuth = Boolean(queryClient.getQueryData<SessionStatus>(queryKeys.session)?.authenticated)
        queryClient.setQueryData(queryKeys.session, sess)
        if (prevAuth) {
          toastManager.add({
            type: "warning",
            title: sess.lastError || "登录状态已失效，请重新登录",
          })
        }
      },
      onReconnect: () => {
        applyInvalidateTargets(queryClient, ["plans", "bookings", "nextTarget", "checkin", "runtime"])
      },
    })
  }, [authenticated, queryClient])

  const logout = useCallback(async () => {
    try {
      await api.logout()
      wasAuthenticated.current = false
      queryClient.setQueryData<SessionStatus>(queryKeys.session, {
        authenticated: false,
        refreshing: false,
      })
      navigate({ to: "/", replace: true })
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "退出登录失败",
      })
    }
  }, [navigate, queryClient])

  /** 刷新当前页：直接通过 TanStack Query invalidate 当前路由数据。 */
  const refreshCurrentPage = useCallback(() => {
    if (pathname === "/bookings") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bookings })
    } else {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans })
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.nextTarget })
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtime })
  }, [pathname, queryClient])

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
      icon: ListChecks,
      keywords: ["plans", "yuyue", "fangan"],
      shortcut: "G P",
      run: () => void navigate({ to: "/plans" }),
    },
    {
      id: "go-bookings",
      label: "当前预约",
      group: "导航",
      icon: CalendarDays,
      keywords: ["bookings", "dangqian"],
      shortcut: "G B",
      run: () => void navigate({ to: "/bookings" }),
    },
    {
      id: "refresh",
      label: "刷新当前页",
      group: "操作",
      icon: RefreshCw,
      keywords: ["refresh", "shuaxin"],
      shortcut: "R",
      run: refreshCurrentPage,
    },
    {
      id: "theme",
      label: theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
      group: "操作",
      icon: theme === "dark" ? Sun : Moon,
      keywords: ["theme", "dark", "light", "zhuti", "shense", "qianse", "qiehuan", "huan"],
      run: () => useAppStore.getState().toggleTheme(),
    },
    {
      id: "changelog",
      label: "查看更新日志",
      group: "操作",
      icon: ExternalLink,
      keywords: ["changelog", "release", "gengxin"],
      run: () =>
        window.open(
          "https://github.com/AlaIchhe/HDU-Library-Sniper/releases",
          "_blank",
          "noopener,noreferrer",
        ),
    },
    {
      id: "logout",
      label: "退出登录",
      group: "账户",
      icon: LogOut,
      keywords: ["logout", "tuichu", "dengchu"],
      run: () => void logout(),
    },
  ]

  const errorState = runtime.data?.state === "error"
  const authRequired = runtime.data?.state === "auth_required"
  const plansActive = pathname === "/plans"
  const bookingsActive = pathname === "/bookings"

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-dvh min-w-0 overflow-x-hidden text-foreground">
        {pathname !== "/" ? <Ambient /> : null}
        <ClickSpark />

        {authenticated && pathname !== "/" ? (
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
        ) : null}

        <ToastProvider>
          {pathname === "/" ? (
            <Outlet />
          ) : navMode === "wide" ? (
            <SidebarProvider className="min-w-0">
              <Sidebar variant="inset">
                <SidebarHeader>
                  <AnimateIcon animateOnHover asChild>
                    <div className="flex items-center gap-3 px-2 py-2">
                      <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                        <LibraryBig className="size-5" />
                      </span>
                      <div className="group-data-[collapsible=icon]:hidden">
                        <strong className="block text-sm font-semibold tracking-tight">
                          <DecryptedText text="HDU Sniper" animateOn="hover" />
                        </strong>
                      </div>
                    </div>
                  </AnimateIcon>
                </SidebarHeader>
                <SidebarContent>
                  <SidebarGroup>
                    <SidebarGroupLabel>工作台</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        <SidebarMenuItem>
                          <AnimateIcon animateOnHover asChild>
                            <SidebarMenuButton
                              isActive={plansActive}
                              tooltip="预约方案（G P）"
                              className="transition-[width,height,padding,background-color,color,box-shadow,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-xs focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar data-[active=true]:shadow-xs"
                              render={<Link to="/plans" />}
                            >
                              <ListChecks size={20} strokeWidth={plansActive ? 2.25 : 1.75} />
                              预约方案
                            </SidebarMenuButton>
                          </AnimateIcon>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                          <AnimateIcon animateOnHover asChild>
                            <SidebarMenuButton
                              isActive={bookingsActive}
                              tooltip="当前预约（G B）"
                              className="transition-[width,height,padding,background-color,color,box-shadow,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-xs focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar data-[active=true]:shadow-xs"
                              render={<Link to="/bookings" />}
                            >
                              <CalendarDays size={20} strokeWidth={bookingsActive ? 2.25 : 1.75} />
                              当前预约
                            </SidebarMenuButton>
                          </AnimateIcon>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>
                <SidebarFooter>
                  <MagicCard className="rounded-xl" gradientSize={140}>
                    <div className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
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
                  </MagicCard>
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
      </div>
    </MotionConfig>
  )
}
