import { describe, expect, test } from "vitest";

import { errorResponse } from "../src/server/errors";
import { AuthenticationExpiredError, HduLibraryError, RequestTimeoutError } from "../src/server/library";

describe("API error responses", () => {
  test("returns 401 when the library session expired", async () => {
    const response = errorResponse(new AuthenticationExpiredError("图书馆登录状态已失效"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "图书馆登录状态已失效" });
  });

  test("returns 504 when the upstream library times out", async () => {
    const response = errorResponse(new RequestTimeoutError("请求超时"));

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ detail: "请求超时" });
  });

  test("returns 502 for other library failures and keeps the reason", async () => {
    const response = errorResponse(new HduLibraryError("请求失败: HTTP 503"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ detail: "请求失败: HTTP 503" });
  });

  test("hides non-Error values behind a generic message", async () => {
    const response = errorResponse("boom");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ detail: "内部服务错误" });
  });
});
