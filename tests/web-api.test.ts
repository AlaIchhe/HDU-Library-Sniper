import { afterEach, describe, expect, test, vi } from "vitest";
import {
  api,
  buildEventUrl,
  resolveApiBase,
  setDesktopTransport,
  setOnUnauthorized,
} from "../src/web/data/api";

afterEach(() => {
  setDesktopTransport("", "");
  setOnUnauthorized(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unified HTTP/SSE API transport", () => {
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

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  test("routes desktop requests over loopback HTTP with Bearer token and SSE query token", async () => {
    setDesktopTransport("http://127.0.0.1:43210/", "secret-token");
    expect(resolveApiBase()).toBe("http://127.0.0.1:43210");
    expect(buildEventUrl("/api/events")).toBe("http://127.0.0.1:43210/api/events?token=secret-token");

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: false, refreshing: false }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.session();

    expect(result).toEqual({ authenticated: false, refreshing: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/api/session",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });

  test("does not expose an HTML SPA response as a JSON parse error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><html></html>", { status: 200 })),
    );
    await expect(api.session()).rejects.toThrow("后台服务返回格式错误");
  });

  test("surfaces backend error details on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "图书馆登录状态已失效" }), { status: 502 })),
    );

    await expect(api.nextTarget()).rejects.toThrow("图书馆登录状态已失效");
  });

  test("invokes onUnauthorized hook on HTTP 401", async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 })),
    );

    await expect(api.bookings()).rejects.toThrow("unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test("serializes path and query parameters according to generated contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, message: "操作成功" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            options: [],
            range: { minBeginTime: 8, maxEndTime: 22, minDuration: 1, maxDuration: 8 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await api.bookingAction("b 1", "checkin");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/bookings/b%201/checkin",
      expect.objectContaining({ method: "POST" }),
    );

    await api.floors("q=76", "自习室");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/catalog/floors?roomQuery=q%3D76&roomType=%E8%87%AA%E4%B9%A0%E5%AE%A4",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
