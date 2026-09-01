import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SessionStatus } from "../shared/types";

type Notice = { tone: "success" | "error" | "warning"; message: string } | null;
type AppStore = {
  session: SessionStatus | null;
  mobileNavOpen: boolean;
  notice: Notice;
  theme: "light" | "dark";
  setSession: (session: SessionStatus | null) => void;
  setMobileNavOpen: (open: boolean) => void;
  setNotice: (notice: Notice) => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
};

export const useAppStore = create<AppStore>()(persist((set) => ({
  session: null,
  mobileNavOpen: false,
  notice: null,
  theme: "light",
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
}), { name: "hdu-sniper-preferences", partialize: (state) => ({ theme: state.theme }) }));

export function initializeTheme() {
  const theme = useAppStore.getState().theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}
