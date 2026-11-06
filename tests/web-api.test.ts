import { afterEach, describe, expect, test, vi } from "vitest";
import { error as logError } from "@tauri-apps/plugin-log";
import { api, resolveApiBase } from "../src/web/api";

// The web API now uses @tauri-apps/plugin-http inside Tauri. In the test
// environment there is no real Tauri runtime, so route the plugin fetch to the
// stubbed global fetch and silence the plugin logger.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  attachConsole: () => Promise.resolve(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("web API base", () => {
  test("keeps relative requests for backend-served WebUI", () => {
    expect(resolveApiBase()).toBe("");
  });

  test("uses the local backend directly inside Tauri", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    expect(resolveApiBase()).toBe("http://127.0.0.1:8000");

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: false, refreshing: false }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.session();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8000/api/session", expect.anything());
  });

  test("does not expose an HTML SPA response as a JSON parse error", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><html></html>")),
    );
    await expect(api.session()).rejects.toThrow("后台服务返回格式错误");
  });

  test("logs the backend detail next to the failing status", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "图书馆登录状态已失效" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(api.nextTarget()).rejects.toThrow("图书馆登录状态已失效");

    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "API 返回错误: http://127.0.0.1:8000/api/runtime/next-target -> 502 (图书馆登录状态已失效)",
    );
  });
});
