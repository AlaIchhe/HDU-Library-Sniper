import { afterEach, describe, expect, test, vi } from "vitest";
import { API_ROUTES, API_SCHEMAS } from "../src/shared/api.generated";
import { api } from "../src/web/data/api";
import { groupResolver, loginResolver, planResolver } from "../src/web/form-resolvers";

const resolverOptions = { fields: {}, shouldUseNativeValidation: false } as const;

describe("form resolvers", () => {
  test("loginResolver trims studentId and enforces required fields", async () => {
    const valid = await loginResolver(
      { studentId: " 23050101 ", password: "secret" },
      undefined,
      resolverOptions,
    );
    expect(valid.errors).toEqual({});
    expect(valid.values).toEqual({ studentId: "23050101", password: "secret" });

    const invalid = await loginResolver({ studentId: "   ", password: "" }, undefined, resolverOptions);
    expect(invalid.errors.studentId?.message).toBe("请输入学号");
    expect(invalid.errors.password?.message).toBe("请输入密码");
  });

  test("planResolver validates floor, seat trimming, and weekday count", async () => {
    const valid = await planResolver(
      {
        roomType: "自习室",
        roomQuery: "study",
        floorId: 3,
        floorName: "三楼",
        seatNum: " 042 ",
        fallback: "043",
        startHour: "8",
        duration: "4",
        weekdays: ["1", "3"],
      },
      undefined,
      resolverOptions,
    );
    expect(valid.errors).toEqual({});
    expect(valid.values).toMatchObject({ floorId: 3, seatNum: "042" });

    const invalid = await planResolver(
      {
        roomType: "",
        roomQuery: "",
        floorId: 0,
        floorName: "",
        seatNum: "   ",
        fallback: "",
        startHour: "",
        duration: "",
        weekdays: [],
      },
      undefined,
      resolverOptions,
    );
    expect(invalid.errors.roomType?.message).toBe("请选择房间类型");
    expect(invalid.errors.floorId?.message).toBe("请选择楼层");
    expect(invalid.errors.seatNum?.message).toBe("请输入座位号");
    expect(invalid.errors.startHour?.message).toBe("请选择开始时间");
    expect(invalid.errors.duration?.message).toBe("请选择时长");
    expect(invalid.errors.weekdays?.message).toBe("至少选择一个星期");
  });

  test("groupResolver trims name and requires at least two member plans", async () => {
    const valid = await groupResolver({ name: " 早八方案 ", ids: ["p1", "p2"] }, undefined, resolverOptions);
    expect(valid.errors).toEqual({});
    expect(valid.values).toEqual({ name: "早八方案", ids: ["p1", "p2"] });

    const invalid = await groupResolver({ name: " ", ids: ["p1"] }, undefined, resolverOptions);
    expect(invalid.errors.name?.message).toBe("请输入组合名称");
    expect(invalid.errors.ids?.message).toBe("至少选择两个方案");
  });
});

describe("API response shape validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("rejects malformed session and checkin payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ authenticated: "yes" }), { status: 200 })),
    );
    await expect(api.session()).rejects.toThrow("后台服务返回格式错误");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ enabled: true, consentVersion: 1 }), { status: 200 })),
    );
    await expect(api.checkinStatus()).rejects.toThrow("后台服务返回格式错误");
  });

  test("every generated route binds to a declared response schema", () => {
    for (const route of Object.values(API_ROUTES)) {
      expect(route.pattern.startsWith("/api/")).toBe(true);
      expect(API_SCHEMAS[route.schema]).toBeDefined();
    }
  });
});
