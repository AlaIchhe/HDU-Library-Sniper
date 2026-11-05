import { useEffect, useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SessionStatus } from "../shared/types";

type Notice = { tone: "success" | "error" | "warning"; message: string } | null;
type AppStore = {
  session: SessionStatus | null;
  mobileNavOpen: boolean;
  notice: Notice;
  theme: "light" | "dark";
  /**
   * 自增计数器：命令面板 / 快捷键请求「刷新当前页」时 +1，
   * 页面用 useRefreshSignal 订阅。用广播而不是 DOM 查询，
   * 页面自己决定刷什么（各自的 react-query key）。
   */
  refreshRequest: number;
  setSession: (session: SessionStatus | null) => void;
  setMobileNavOpen: (open: boolean) => void;
  setNotice: (notice: Notice) => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
  requestRefresh: () => void;
};

export const useAppStore = create<AppStore>()(persist((set) => ({
  session: null,
  mobileNavOpen: false,
  notice: null,
  theme: "light",
  refreshRequest: 0,
  setSession: (session) => set({ session }),
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  setNotice: (notice) => set({ notice }),
  setTheme: (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    return set({ theme });
  },
  toggleTheme: () => set((state) => {
    const theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
    return { theme };
  }),
  requestRefresh: () => set((state) => ({ refreshRequest: state.refreshRequest + 1 })),
}), { name: "hdu-sniper-preferences", partialize: (state) => ({ theme: state.theme }) }));

export function initializeTheme() {
  const theme = useAppStore.getState().theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/**
 * 订阅「刷新当前页」广播。首次挂载不触发，只在计数增加时调用 handler，
 * 避免页面刚打开就白白多刷一次。
 */
export function useRefreshSignal(handler: () => void) {
  const count = useAppStore((state) => state.refreshRequest);
  const seen = useRef(count);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (count === seen.current) return;
    seen.current = count;
    handlerRef.current();
  }, [count]);
}
