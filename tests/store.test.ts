import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initializeTheme, useAppStore } from "../src/web/data/store";
import { consumeReturnTo, forgetReturnTo, rememberReturnTo } from "../src/web/return-to";

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

describe("useAppStore", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    document.documentElement.classList.remove("dark");
    useAppStore.getState().setSession(null);
    useAppStore.getState().setTheme("light");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("toggles theme and persists preference under hdu-sniper-preferences", () => {
    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(JSON.parse(globalThis.localStorage.getItem("hdu-sniper-preferences") ?? "{}")).toMatchObject({
      state: { theme: "dark" },
    });

    document.documentElement.classList.remove("dark");
    initializeTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("return-to navigation guard", () => {
  afterEach(() => {
    forgetReturnTo();
    sessionStorage.clear();
  });

  test("remembers only internal paths and resets after forgetReturnTo", () => {
    expect(consumeReturnTo()).toBe("/plans");

    rememberReturnTo("https://evil.example/phish");
    expect(consumeReturnTo()).toBe("/plans");

    rememberReturnTo("//evil.example");
    expect(consumeReturnTo()).toBe("/plans");

    rememberReturnTo("/bookings");
    expect(consumeReturnTo()).toBe("/bookings");

    forgetReturnTo();
    expect(consumeReturnTo()).toBe("/plans");
  });
});
