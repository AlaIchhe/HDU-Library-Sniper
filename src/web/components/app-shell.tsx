"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import {
  IconCalendarEvent,
  IconCalendarEventFilled,
  IconClock,
  IconCommand as CommandIcon,
  IconExternalLink,
  IconLibrary,
  IconListCheck,
  IconListCheckFilled,
  IconLogout,
  IconMoon,
  IconRefresh,
  IconSun,
} from "@tabler/icons-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AnimatedGridPattern } from "@/components/ui/animated-grid-pattern"
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "@/components/ui/menu"
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
import { useQueryClient } from "@tanstack/react-query"
import { useAppStore } from "../store"
import { queryKeys, useCheckin, useCheckinMutation, useNextTarget, useRuntime, useSession } from "../queries"
import { LightRays } from "@/components/ui/light-rays"
import { api } from "../api"
import { notifyAuditEvents } from "../notifications"
import { openExternalUrl } from "../tauri"
import { forgetReturnTo, rememberReturnTo } from "../return-to"
import { startUpdateCheck } from "../updater"
import { UpdatePill } from "./update-pill"
import { CommandPalette } from "./command-palette"
import { useHotkeys } from "../hooks/use-hotkeys"
import { useCountdown } from "../hooks/use-countdown"
import type { Command } from "../commands"

/** 统一的语义色状态点：颜色由 tone 决定，切换时用 spring 过渡而非硬切。 */
function StatusDot({ tone, pulse = false }: { tone: "ok" | "warn" | "bad" | "idle"; pulse?: boolean }) {
  const reduced = useReducedMotion()
  const color = {
    ok: "bg-success",
    warn: "bg-warning",
    bad: "bg-destructive",
    idle: "bg-muted-foreground/50",
  }[tone]

  return (
    <span className="relative grid size-2 shrink-0 place-items-center">
      {pulse && tone !== "idle" && !reduced && (
        <motion.span
          aria-hidden
          className={`absolute inset-0 rounded-full ${color}`}
          initial={{ scale: 1, opacity: 0 }}
          animate={{ scale: [1, 2.6], opacity: [0.5, 0] }}
          transition={{
            type: "spring",
            visualDuration: 1.4,
            bounce: 0,
            repeat: Infinity,
            repeatDelay: 0.6,
          }}
        />
      )}
      <motion.span
        className={`absolute inset-0 rounded-full ${color}`}
        initial={false}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
      />
    </span>
  )
}

/**
 * 顶栏状态区：一眼看清「后台在不在线、下一次什么时候动」。
 *
 * 倒计时只用本地 timer 重算，不发网络请求。
 */
function StatusBar({ runtimeState }: { runtimeState: string | undefined }) {
  const target = useNextTarget()
  const countdown = useCountdown(target.data?.at)
  const reduced = useReducedMotion()

  const tone: "ok" | "warn" | "bad" | "idle" =
    runtimeState === "error"
      ? "bad"
      : runtimeState === "auth_required"
        ? "warn"
        : runtimeState === "running"
          ? "ok"
          : target.data?.kind && target.data.kind !== "none"
            ? "ok"
            : "idle"

  const label = target.data?.label || "等待方案启用"

  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-full border bg-card/60 py-1 ps-2.5 pe-3 text-xs shadow-xs/5 backdrop-blur">
      <StatusDot tone={tone} pulse={runtimeState === "running"} />

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-muted-foreground">下一次</span>
        <span className="max-w-[16rem] truncate font-medium text-foreground" title={label}>
          {label}
        </span>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {target.data?.at ? (
          <motion.span
            key={countdown?.text ?? "loading"}
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
            className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground"
          >
            <IconClock className="size-3" />
            {countdown?.text ?? "…"}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function CheckinControl() {
  const { data, isLoading } = useCheckin()
  const mutation = useCheckinMutation()
  const [pending, setPending] = useState<boolean | null>(null)

  async function confirm() {
    if (pending === null) return
    try {
      await mutation.mutateAsync({ enabled: pending, agreed: pending })
      toastManager.add({
        type: "success",
        title: pending ? "自动签到已启用" : "自动签到已关闭",
      })
      setPending(null)
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "自动签到设置失败",
      })
    }
  }

  return (
    <>
      <Button
        variant={data?.enabled ? "secondary" : "ghost"}
        size="sm"
        disabled={isLoading || mutation.isPending}
        onClick={() => {
          if (data) setPending(!data.enabled)
        }}
        title={data?.enabled ? "自动签到已开启，点击关闭" : "自动签到已关闭，点击开启"}
      >
        <StatusDot tone={data?.enabled ? "ok" : "idle"} />
        <span className="max-sm:hidden">{data?.enabled ? "自动签到" : "未开签到"}</span>
      </Button>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setPending(null)
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? "启用自动签到？" : "关闭自动签到？"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? "自动签到会在服务端签到窗口内提交签到请求。继续启用吗？"
                : "关闭后不会再自动提交签到，已有预约仍可手动签到。确定关闭吗？"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={mutation.isPending} />}>
              取消
            </AlertDialogClose>
            <Button loading={mutation.isPending} onClick={() => void confirm()}>
              {pending ? "启用" : "关闭"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  )
}

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
  const reduced = useReducedMotion()
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
    <div className="relative min-h-dvh min-w-0 overflow-x-hidden bg-background text-foreground">
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
                          {plansActive ? <IconListCheckFilled size={16} /> : <IconListCheck size={16} />}
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
                            <IconCalendarEventFilled size={16} />
                          ) : (
                            <IconCalendarEvent size={16} />
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
              <header className="sticky top-0 z-20 flex min-h-14 min-w-0 items-center gap-3 border-b bg-background/82 px-3 backdrop-blur sm:px-6">
                <SidebarTrigger />
                <Separator orientation="vertical" className="h-5" />
                <StatusBar runtimeState={runtime.data?.state} />
                <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 text-muted-foreground hover:text-foreground"
                    onClick={() => setPaletteOpen(true)}
                  >
                    <CommandIcon className="size-3.5" />
                    <span className="max-lg:hidden">搜索命令</span>
                    <MenuShortcut className="me-0 max-lg:hidden">⌘K</MenuShortcut>
                  </Button>
                  <UpdatePill />
                  <CheckinControl />
                  <AnimatedThemeToggler
                    className="grid size-8 place-items-center rounded-full border text-foreground/80 transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
                    theme={theme}
                    onThemeChange={(nextTheme) => useAppStore.getState().setTheme(nextTheme)}
                  />
                  <Menu>
                    <MenuTrigger className="rounded-full outline-none" aria-label="用户菜单">
                      <Avatar className="size-8">
                        <AvatarFallback>{session?.name?.slice(0, 1) || "H"}</AvatarFallback>
                      </Avatar>
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuGroup>
                        <MenuGroupLabel>{session?.name || "已登录"}</MenuGroupLabel>
                        <MenuItem
                          onClick={() =>
                            void openExternalUrl("https://github.com/AlaIchhe/HDU-Library-Sniper/releases")
                          }
                        >
                          <IconExternalLink />
                          更新日志
                        </MenuItem>
                      </MenuGroup>
                      <MenuSeparator />
                      <MenuItem variant="destructive" onClick={() => void logout()}>
                        <IconLogout />
                        退出登录
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
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
            </SidebarInset>
          </SidebarProvider>
        </ToastProvider>
      )}
    </div>
  )
}
