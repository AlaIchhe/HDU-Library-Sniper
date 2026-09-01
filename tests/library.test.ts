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

describe("LibraryClient.floors parsing", () => {
  test("collects floor nodes regardless of the nested tree shape", async () => {
    const client = makeClient(async (path) => {
      // The first GET returns the space_category; the POST returns the seat map.
      if (path.includes("space_category[")) {
        return { data: { space_category: { category_id: "1", content_id: "91" } } as Record<string, unknown> } as unknown as Record<string, unknown>;
      }
      return {
        allContent: {
          children: [
            { children: [{ children: [] }] },
            {
              children: [
                {
                  roomName: "四楼",
                  seatMap: { info: { id: "1558" }, POIs: [{ title: "298" }, { title: "299" }] },
                },
              ],
            },
          ],
        },
      };
    });
    const floors = await client.floors("space_category[category_id]=1&space_category[content_id]=91", new Date(), 1);
    expect(floors).toHaveLength(1);
    expect((floors[0] as Record<string, unknown>).roomName).toBe("四楼");
  });

  test("falls back to the query string when space_category is absent", async () => {
    let postBody: URLSearchParams | undefined;
    const client = makeClient(async (path, init) => {
      if (path.includes("space_category[")) return { data: {} } as Record<string, unknown>;
      postBody = init?.body instanceof URLSearchParams ? init.body : undefined;
      return {
        allContent: {
          children: [
            {
              roomName: "三楼",
              seatMap: { info: { id: "42" }, POIs: [{ title: "101" }] },
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
          "/User/Center/baseInfo?LAB_JSON=0", {}, false,
        ),
      ).rejects.toBeInstanceOf(AuthenticationExpiredError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("LibraryClient.roomTypes parsing", () => {
  test("searches all content children for defaultItems", async () => {
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
