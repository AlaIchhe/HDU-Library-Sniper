import { afterEach, describe, expect, test, vi } from "vitest";
import { api, resolveApiBase } from "../src/web/data/api";

function stubMyGoCall(callImpl: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("mygo", { call: callImpl });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  });

  test("routes requests through MyGo DesktopAPI inside the desktop app", async () => {
    const callMock = vi.fn().mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ authenticated: false, refreshing: false }),
    });
    stubMyGoCall(callMock);

    const result = await api.session();

    expect(result).toEqual({ authenticated: false, refreshing: false });
    expect(callMock).toHaveBeenCalledWith("DesktopAPI.Request", "GET", "/api/session", "");
  });

  test("does not expose an HTML SPA response as a JSON parse error", async () => {
    stubMyGoCall(
      vi.fn().mockResolvedValueOnce({
        status: 200,
        body: "<!doctype html><html></html>",
      }),
    );
    await expect(api.session()).rejects.toThrow("后台服务返回格式错误");
  });

  test("logs the backend detail next to the failing status", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubMyGoCall(
      vi.fn().mockResolvedValueOnce({
        status: 502,
        body: JSON.stringify({ detail: "图书馆登录状态已失效" }),
      }),
    );

    await expect(api.nextTarget()).rejects.toThrow("图书馆登录状态已失效");

    expect(errorSpy).toHaveBeenCalledWith(
      "API 返回错误: /api/runtime/next-target -> 502 (图书馆登录状态已失效)",
    );
  });

  test("surfaces IPC errors when local service failed to initialize", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubMyGoCall(vi.fn().mockRejectedValueOnce("startup API error: db locked"));

    await expect(api.session()).rejects.toThrow("本地服务不可用：startup API error: db locked");
    expect(errorSpy).toHaveBeenCalledWith("API 请求失败: /api/session -> startup API error: db locked");
  });

  test("only sends ?refresh=1 when explicitly triggered for catalog lazy refresh", async () => {
    const callMock = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ options: [] }),
    });
    stubMyGoCall(callMock);

    await api.roomTypes();
    await api.roomTypes(true);
    await api.floors("q=1", "自习室", true);

    expect(callMock).toHaveBeenNthCalledWith(1, "DesktopAPI.Request", "GET", "/api/catalog/room-types", "");
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      "DesktopAPI.Request",
      "GET",
      "/api/catalog/room-types?refresh=1",
      "",
    );
    expect(callMock).toHaveBeenNthCalledWith(
      3,
      "DesktopAPI.Request",
      "GET",
      "/api/catalog/floors?roomQuery=q%3D1&roomType=%E8%87%AA%E4%B9%A0%E5%AE%A4&refresh=1",
      "",
    );
  });
});
