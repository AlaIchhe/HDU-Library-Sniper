"use client"

import { Outlet } from "@tanstack/react-router"
import { IconCommand as CommandIcon, IconExternalLink, IconLogout } from "@tabler/icons-react"
import { motion, useReducedMotion } from "motion/react"

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
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useAppStore } from "../../store"
import { openExternalUrl } from "../../tauri"
import { UpdatePill } from "../update-pill"
import { cn } from "@/lib/utils"

/** 统一的语义色状态点：颜色由 tone 决定，切换时用 spring 过渡而非硬切。 */
import { CheckinControl, StatusBar } from "./status"

export function AppHeader({
  sessionName,
  theme,
  runtimeState,
  showSidebarTrigger,
  onOpenPalette,
  onLogout,
}: {
  sessionName: string | undefined
  theme: "light" | "dark"
  runtimeState: string | undefined
  showSidebarTrigger: boolean
  onOpenPalette: () => void
  onLogout: () => void
}) {
  return (
    <header className="sticky top-0 z-40 flex min-h-14 min-w-0 items-center gap-3 border-b bg-background/82 px-3 backdrop-blur sm:px-6">
      {showSidebarTrigger ? (
        <>
          <SidebarTrigger aria-label="切换侧栏" />
          <Separator orientation="vertical" className="h-5" />
        </>
      ) : null}
      <StatusBar runtimeState={runtimeState} />
      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-muted-foreground hover:text-foreground"
          onClick={onOpenPalette}
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
              <AvatarFallback>{sessionName?.slice(0, 1) || "H"}</AvatarFallback>
            </Avatar>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>{sessionName || "已登录"}</MenuGroupLabel>
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
            <MenuItem variant="destructive" onClick={() => void onLogout()}>
              <IconLogout />
              退出登录
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </header>
  )
}

export function AppContent({ pathname, compact }: { pathname: string; compact: boolean }) {
  const reduced = useReducedMotion()

  return (
    <main
      className={cn(
        "mx-auto min-w-0 w-full max-w-7xl flex-1 overflow-x-hidden p-4 sm:p-8",
        compact && "pb-28 sm:pb-28",
      )}
    >
      <motion.div
        key={pathname}
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <Outlet />
      </motion.div>
    </main>
  )
}
