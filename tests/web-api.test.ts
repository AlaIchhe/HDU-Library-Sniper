import { afterEach, describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { error as logError } from "@tauri-apps/plugin-log";
import { api, resolveApiBase } from "../src/web/data/api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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

describe("web API transport", () => {
  test("keeps relative HTTP requests for backend-served WebUI", async () => {
    expect(resolveApiBase()).toBe("");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: false, refreshing: false }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.session();

    expect(fetchMock).toHaveBeenCalledWith("/api/session", expect.anything());
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  test("routes requests through Tauri IPC inside the desktop app", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ authenticated: false, refreshing: false }),
    });

    const result = await api.session();

    expect(result).toEqual({ authenticated: false, refreshing: false });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("api_request", {
      request: {
        method: "GET",
        path: "/api/session",
        body: undefined,
      },
    });
  });

  test("does not expose an HTML SPA response as a JSON parse error", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 200,
      body: "<!doctype html><html></html>",
    });
    await expect(api.session()).rejects.toThrow("后台服务返回格式错误");
  });

  test("logs the backend detail next to the failing status", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.mocked(invoke).mockResolvedValueOnce({
      status: 502,
      body: JSON.stringify({ detail: "图书馆登录状态已失效" }),
    });

    await expect(api.nextTarget()).rejects.toThrow("图书馆登录状态已失效");

    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "API 返回错误: /api/runtime/next-target -> 502 (图书馆登录状态已失效)",
    );
  });

  test("surfaces IPC errors when local router failed to initialize", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.mocked(invoke).mockRejectedValueOnce("startup API error: db locked");

    await expect(api.session()).rejects.toThrow("本地服务不可用：startup API error: db locked");
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "API 请求失败: /api/session -> startup API error: db locked",
    );
  });
});
