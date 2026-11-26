"use client"

import { Outlet } from "@tanstack/react-router"

import { AnimatedThemeToggler } from "@/ui/animated-theme-toggler"
import { Avatar, AvatarFallback } from "@/ui/avatar"
import { BlurFade } from "@/ui/blur-fade"
import { Button } from "@/ui/button"
import { AnimateIcon, Command as CommandIcon, ExternalLink, LogOut } from "@/ui/icons"
import { Magnet } from "@/ui/magnet"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "@/ui/menu"
import { Separator } from "@/ui/separator"
import { SidebarTrigger } from "@/ui/sidebar"
import { useAppStore } from "../../data/store"
import { cn } from "@/lib/utils"

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
    <header className="glass sticky top-0 z-40 flex min-h-14 min-w-0 items-center gap-3 border-b px-3 sm:px-6">
      {showSidebarTrigger ? (
        <>
          <SidebarTrigger aria-label="切换侧栏" />
          <Separator orientation="vertical" className="h-5" />
        </>
      ) : null}
      <StatusBar runtimeState={runtimeState} />
      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
        <AnimateIcon animateOnHover asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label="搜索命令"
            className="gap-2 text-muted-foreground hover:text-foreground"
            onClick={onOpenPalette}
          >
            <CommandIcon className="size-3.5" />
            <span className="max-lg:hidden">搜索命令</span>
            <MenuShortcut className="me-0 max-lg:hidden">⌘K</MenuShortcut>
          </Button>
        </AnimateIcon>
        <CheckinControl />
        <Magnet padding={24} magnetStrength={6}>
          <AnimatedThemeToggler
            className="grid size-8 place-items-center rounded-full border text-foreground/80 transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
            theme={theme}
            onThemeChange={(nextTheme) => useAppStore.getState().setTheme(nextTheme)}
          />
        </Magnet>
        <Menu>
          <MenuTrigger className="rounded-full outline-none" aria-label="用户菜单">
            <Avatar className="size-8">
              <AvatarFallback>{sessionName?.slice(0, 1) || "H"}</AvatarFallback>
            </Avatar>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>{sessionName || "已登录"}</MenuGroupLabel>
              <AnimateIcon animateOnHover asChild>
                <MenuItem
                  onClick={() =>
                    window.open(
                      "https://github.com/AlaIchhe/HDU-Library-Sniper/releases",
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <ExternalLink />
                  更新日志
                </MenuItem>
              </AnimateIcon>
            </MenuGroup>
            <MenuSeparator />
            <AnimateIcon animateOnHover asChild>
              <MenuItem variant="destructive" onClick={() => void onLogout()}>
                <LogOut />
                退出登录
              </MenuItem>
            </AnimateIcon>
          </MenuPopup>
        </Menu>
      </div>
    </header>
  )
}

export function AppContent({ pathname, compact }: { pathname: string; compact: boolean }) {
  return (
    <main
      className={cn(
        "mx-auto min-w-0 w-full max-w-7xl flex-1 overflow-x-hidden p-4 sm:p-8",
        compact && "pb-28 sm:pb-28",
      )}
    >
      <BlurFade key={pathname} duration={0.22} offset={6} blur="3px">
        <Outlet />
      </BlurFade>
    </main>
  )
}
