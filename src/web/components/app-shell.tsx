"use client"

import { useEffect } from "react"
import { Link, Outlet, useRouterState } from "@tanstack/react-router"
import { CalendarDays, Library, ListChecks, Settings } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { AnimatedGridPattern } from "@/components/ui/animated-grid-pattern"
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { MagicCard } from "@/components/ui/magic-card"
import { Separator } from "@/components/ui/separator"
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
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { toastManager, ToastProvider } from "@/components/ui/toast"
import { useAppStore } from "../store"
import {
  useCheckin,
  useCheckinMutation,
  useNextTarget,
  useRuntime,
} from "../queries"
import { LightRays } from "@/components/ui/light-rays"

function CheckinControl() {
  const { data, isLoading } = useCheckin()
  const mutation = useCheckinMutation()

  async function toggle() {
    if (!data) return
    const enabled = !data.enabled
    if (
      !window.confirm(
        enabled
          ? "自动签到会在服务端签到窗口内提交签到请求。继续启用吗？"
          : "关闭自动签到吗？",
      )
    )
      return
    try {
      await mutation.mutateAsync({ enabled, agreed: enabled })
      toastManager.add({
        type: "success",
        title: enabled ? "自动签到已启用" : "自动签到已关闭",
      })
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "自动签到设置失败",
      })
    }
  }

  return (
    <Button
      variant={data?.enabled ? "secondary" : "outline"}
      size="sm"
      disabled={isLoading || mutation.isPending}
      onClick={() => void toggle()}
    >
      <span
        className={
          data?.enabled ? "text-success" : "text-muted-foreground/40"
        }
      >
        ●
      </span>
      {data?.enabled ? "自动签到已开" : "自动签到已关"}
    </Button>
  )
}

function NextBlock({
  label,
  at,
}: {
  label?: string
  at?: string
}) {
  return (
    <div className="rounded-lg border bg-sidebar-accent p-3 text-xs">
      <div className="flex items-center gap-2 font-medium">
        <Settings className="size-3.5" />
        下一次执行
      </div>
      <strong className="mt-2 block">{label || "正在计算..."}</strong>
      {at ? <span className="text-muted-foreground">{at}</span> : null}
    </div>
  )
}

export function AppShell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname as string,
  })
  const session = useAppStore((state) => state.session)
  const theme = useAppStore((state) => state.theme)
  const notice = useAppStore((state) => state.notice)
  const setNotice = useAppStore((state) => state.setNotice)
  const target = useNextTarget()
  const runtime = useRuntime()
  const reduced = useReducedMotion()

  useEffect(() => {
    if (!notice) return
    toastManager.add({
      type: notice.tone === "error" ? "error" : notice.tone === "warning" ? "warning" : "success",
      title: notice.message,
    })
    setNotice(null)
  }, [notice, setNotice])

  const errorState = runtime.data?.state === "error"

  return (
    <div className="relative min-h-dvh bg-background text-foreground">
      <LightRays
        count={5}
        color="rgba(140, 180, 255, 0.12)"
        blur={28}
        speed={18}
        className="fixed inset-0 -z-10"
      />
      <AnimatedGridPattern
        numSquares={36}
        maxOpacity={0.06}
        className="fixed inset-0 -z-10 [mask-image:radial-gradient(ellipse_at_center,white,transparent_72%)]"
      />

      {pathname === "/" ? (
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      ) : (
        <ToastProvider>
          <SidebarProvider>
            <Sidebar variant="inset">
              <SidebarHeader>
                <div className="flex items-center gap-3 px-2 py-2">
                  <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg">
                    <Library className="size-5" />
                  </span>
                  <div className="group-data-[collapsible=icon]:hidden">
                    <strong className="block text-sm">HDU Sniper</strong>
                    <span className="text-xs text-muted-foreground">
                      预约工作台
                    </span>
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
                          isActive={pathname === "/plans"}
                          render={<Link to="/plans" />}
                        >
                          <ListChecks className="size-4" />
                          预约方案
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={pathname === "/bookings"}
                          render={<Link to="/bookings" />}
                        >
                          <CalendarDays className="size-4" />
                          当前预约
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
              <SidebarFooter>
                <MagicCard className="p-3" gradientOpacity={0.08}>
                  <NextBlock
                    label={target.data?.label}
                    at={target.data?.at}
                  />
                </MagicCard>
                <div className="mt-3 flex items-center gap-2 px-2 text-xs text-muted-foreground">
                  <span
                    className={
                      errorState
                        ? "size-2 rounded-full bg-destructive"
                        : "size-2 rounded-full bg-success"
                    }
                  />
                  后台服务在线
                </div>
              </SidebarFooter>
            </Sidebar>
            <SidebarInset className="min-w-0 w-full max-w-full overflow-x-hidden">
              <header className="flex min-h-14 items-center gap-3 border-b bg-background/82 px-4 backdrop-blur sm:px-6">
                <SidebarTrigger />
                <Separator orientation="vertical" className="h-5" />
                <nav className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
                  <Library className="size-4" />
                  HDU Library
                  <span>/</span>
                  <strong className="text-foreground">
                    {pathname === "/bookings" ? "当前预约" : "预约方案"}
                  </strong>
                </nav>
                <div className="ml-auto flex items-center gap-2">
                  <CheckinControl />
                  <AnimatedThemeToggler
                    className="grid size-9 place-items-center rounded-full border text-foreground/80 transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
                    theme={theme}
                    onThemeChange={(nextTheme) =>
                      useAppStore.getState().setTheme(nextTheme)
                    }
                  />
                  <Avatar className="size-8">
                    <AvatarFallback>
                      {session?.name?.slice(0, 1) || "H"}
                    </AvatarFallback>
                  </Avatar>
                </div>
              </header>
              <main className="mx-auto min-w-0 w-full max-w-7xl flex-1 overflow-x-hidden p-4 sm:p-8">
                <motion.div
                  key={pathname}
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Outlet />
                </motion.div>
              </main>
              <footer className="px-4 pb-4 text-xs text-muted-foreground sm:px-8">
                自动预约与无头签到由本地后台服务持续执行
              </footer>
            </SidebarInset>
          </SidebarProvider>
        </ToastProvider>
      )}
    </div>
  )
}
