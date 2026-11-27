import { afterEach, describe, expect, test, vi } from "vitest";
import { API_ROUTES, API_SCHEMAS } from "../src/shared/api.generated";
import { api } from "../src/web/data/api";
import { loginResolver, planResolver } from "../src/web/form-resolvers";

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

  test("planResolver validates slots, non-overlapping time windows, and weekday count", async () => {
    const valid = await planResolver(
      {
        name: "全天方案",
        slots: [
          {
            roomType: "自习室",
            roomQuery: "study",
            floorId: 3,
            floorName: "三楼",
            seatNum: " 042 ",
            fallback: "043",
            startHour: "8",
            duration: "4",
          },
          {
            roomType: "自习室",
            roomQuery: "study",
            floorId: 3,
            floorName: "三楼",
            seatNum: "042",
            fallback: "",
            startHour: "14",
            duration: "4",
          },
        ],
        weekdays: ["1", "3"],
      },
      undefined,
      resolverOptions,
    );
    expect(valid.errors).toEqual({});
    expect(valid.values).toMatchObject({
      name: "全天方案",
      slots: [
        expect.objectContaining({ floorId: 3, seatNum: "042" }),
        expect.objectContaining({ floorId: 3, seatNum: "042" }),
      ],
    });

    const overlapping = await planResolver(
      {
        name: "重叠方案",
        slots: [
          {
            roomType: "自习室",
            roomQuery: "study",
            floorId: 3,
            seatNum: "042",
            startHour: "8",
            duration: "4",
          },
          {
            roomType: "自习室",
            roomQuery: "study",
            floorId: 3,
            seatNum: "042",
            startHour: "10",
            duration: "2",
          },
        ],
        weekdays: ["1"],
      },
      undefined,
      resolverOptions,
    );
    expect(overlapping.errors.slots?.message).toBe("方案内各时段不能重叠");

    const invalid = await planResolver(
      {
        name: "",
        slots: [
          {
            roomType: "",
            roomQuery: "",
            floorId: 0,
            floorName: "",
            seatNum: "   ",
            fallback: "",
            startHour: "",
            duration: "",
          },
        ],
        weekdays: [],
      },
      undefined,
      resolverOptions,
    );
    expect(invalid.errors.slots?.message).toBe("请选择房间类型");
    expect(invalid.errors.weekdays?.message).toBe("至少选择一个星期");
  });
});

describe("API response shape validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("rejects malformed nested and enum payloads", async () => {
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

    // Nested enum validation inside NextExecutionTarget
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ kind: "invalid-kind", label: "x" }), { status: 200 })),
    );
    await expect(api.nextTarget()).rejects.toThrow("后台服务返回格式错误");
  });

  test("every generated route binds to a declared response schema", () => {
    for (const route of Object.values(API_ROUTES)) {
      expect(route.pattern.startsWith("/api/")).toBe(true);
      expect(API_SCHEMAS[route.schema]).toBeDefined();
    }
  });
});
