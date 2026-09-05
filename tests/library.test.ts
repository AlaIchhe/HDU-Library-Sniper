import { describe, expect, test } from "vitest";
import { AuthenticationExpiredError, LibraryClient } from "../src/server/library";

function makeClient(request: (path: string, init?: RequestInit) => Promise<Record<string, unknown>>): LibraryClient {
  const client = new LibraryClient({});
  // `request` is private in the type system, but the runtime method is what
  // library.floors / lookupCategory rely on; override it for the test.
  (client as unknown as { request: typeof request }).request = async (path: string, init?: RequestInit) =>
    request(path, init);
  return client;
}

describe("LibraryClient contract parsing", () => {
  test("parses the exact Huitu seat map path", async () => {
    const client = makeClient(async (path) => {
      // The first GET returns the space_category; the POST returns the seat map.
      if (path.includes("space_category[")) {
        return { data: { space_category: { category_id: "1", content_id: "91" } } as Record<string, unknown> } as unknown as Record<string, unknown>;
      }
      return {
        allContent: {
          children: [
            { children: {} },
            {
              children: [
                { roomName: "废弃节点" },
              ],
            },
            {
              children: {
                children: [
                  {
                    roomName: "四楼",
                    seatMap: { info: { id: "1558" }, POIs: [{ title: "298" }, { title: "299" }] },
                  },
                ],
              },
            },
          ],
        },
      };
    });
    const floors = await client.floors("space_category[category_id]=1&space_category[content_id]=91", new Date(), 1);
    expect(floors).toHaveLength(1);
    expect((floors[0] as Record<string, unknown>).roomName).toBe("四楼");
  });

  test("uses space_category from the Huitu room detail", async () => {
    let postBody: URLSearchParams | undefined;
    const client = makeClient(async (path, init) => {
      if (path.includes("space_category[")) {
        return {
          data: { space_category: { category_id: "7", content_id: "12" } },
        } as unknown as Record<string, unknown>;
      }
      postBody = init?.body instanceof URLSearchParams ? init.body : undefined;
        return {
          allContent: {
            children: [
              { children: {} },
              { children: {} },
              {
                children: {
                  children: [
                    {
                      roomName: "三楼",
                      seatMap: { info: { id: "42" }, POIs: [{ title: "101" }] },
                    },
                  ],
                },
              },
            ],
          },
        };
    });
    const floors = await client.floors("space_category[category_id]=7&space_category[content_id]=12", new Date(), 1);
    expect(floors).toHaveLength(1);
    expect(postBody?.get("space_category[category_id]")).toBe("7");
    expect(postBody?.get("space_category[content_id]")).toBe("12");
  });
});

describe("LibraryClient.request auth handling", () => {
  test("treats com.Redirect responses as authentication expiry", async () => {
    const client = new LibraryClient({});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ ui_type: "com.Redirect", href: "https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    try {
      await expect(
        (client as unknown as { request: (p: string, i?: RequestInit, r?: boolean) => Promise<Record<string, unknown>> }).request(
          "/User/Center/baseInfo", {}, false,
        ),
      ).rejects.toBeInstanceOf(AuthenticationExpiredError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("LibraryClient roomTypes parsing", () => {
  test("parses the exact Huitu room types path", async () => {
    const client = makeClient(async (path) => {
      expect(path).toBe("/Space/Category/list?LAB_JSON=1");
      return {
        content: {
          children: [
            { name: "A", defaultItems: [] },
            {
              name: "B",
              defaultItems: [
                { name: "自习室", link: { url: "/Seat/Index/searchSeats?space_category[category_id]=1&space_category[content_id]=91" } },
              ],
            },
          ],
        },
      };
    });
    const types = await client.roomTypes();
    expect(types).toEqual([{ name: "自习室", query: "space_category[category_id]=1&space_category[content_id]=91" }]);
  });
});

describe("LibraryClient.bookingRange parsing", () => {
  test("parses the allowed booking range from searchSeats", async () => {
    const client = makeClient(async () => ({
      data: { range: { minBeginTime: 7, maxEndTime: 22, min_duration: 1, max_duration: 15 } },
    }));
    const range = await client.bookingRange("space_category[category_id]=591&space_category[content_id]=3");
    expect(range).toEqual({ minBeginTime: 7, maxEndTime: 22, minDuration: 1, maxDuration: 15 });
  });
});

describe("LibraryClient.bookSeat", () => {
  test("submits the booking request with LAB_JSON=1 and an Api-Token header", async () => {
    let captured: { path: string; init?: RequestInit } | undefined;
    const client = makeClient(async (path, init) => {
      captured = { path, init };
      return { CODE: "ok", DATA: { result: "success" } } as unknown as Record<string, unknown>;
    });
    client.uid = "304174";

    await client.bookSeat("42", new Date(2026, 8, 5, 9, 0, 0), 12);

    // LAB_JSON=1 是慧图 xH 请求的默认契约，Api-Token 签名串也按该形式计算。
    expect(captured?.path).toBe("/Seat/Index/bookSeats?LAB_JSON=1");
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get("Api-Token")).toBeTruthy();
    const body = captured?.init?.body instanceof URLSearchParams ? captured.init.body : undefined;
    expect(body?.get("seats[0]")).toBe("42");
    expect(body?.get("seatBookers[0]")).toBe("304174");
    expect(body?.get("duration")).toBe(String(12 * 3600));
  });
});

describe("LibraryClient.action", () => {
  function actionClient() {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const client = makeClient(async (path, init) => {
      calls.push({ path, init });
      if (path.startsWith("/Seat/Index/stepOutLatestComeBackTime")) {
        return {
          CODE: "ok",
          DATA: { result: "success", latest_come_back_time: 1800 },
        } as unknown as Record<string, unknown>;
      }
      return { CODE: "ok", DATA: { result: "success" } } as unknown as Record<string, unknown>;
    });
    return { calls, client };
  }

  test("uses Huitu frontend endpoints and the default LAB_JSON contract", async () => {
    const cases: Array<[Parameters<LibraryClient["action"]>[0], string]> = [
      ["cancel", "/Seat/Index/cancelBooking?bookingId=123&LAB_JSON=1"],
      ["checkIn", "/Seat/Index/checkIn?bookingId=123&LAB_JSON=1"],
      ["comeBack", "/Seat/Index/comeBack?bookingId=123&LAB_JSON=1"],
      ["signOut", "/Seat/Index/checkOut?bookingId=123&LAB_JSON=1"],
    ];

    for (const [kind, expectedPath] of cases) {
      const { calls, client } = actionClient();
      await client.action(kind, "123");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).toBe(expectedPath);
      expect(calls[0]?.init?.method).toBe("POST");
    }
  });

  test("performs leave as latest-time lookup followed by stepOut", async () => {
    const { calls, client } = actionClient();

    await client.action("leave", "123");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/Seat/Index/stepOutLatestComeBackTime?bookingId=123&LAB_JSON=1");
    expect(calls[1]?.path).toBe("/Seat/Index/stepOut?bookingId=123&LAB_JSON=1");
    const body = calls[1]?.init?.body instanceof URLSearchParams ? calls[1].init.body : undefined;
    expect(body?.get("comeBackTime")).toBe("1800");
  });

  test("prefers DATA.msg for business failures", async () => {
    const client = makeClient(async () => ({
      CODE: "ok",
      MESSAGE: "顶层信息",
      DATA: { result: "fail", msg: "预约单不存在" },
    } as unknown as Record<string, unknown>));

    await expect(client.action("checkIn", "123")).rejects.toThrow("预约单不存在");
  });
});
