import { describe, expect, test } from "vitest";
import { CookieJar, parseSetCookie } from "../src/server/cookies";

describe("CookieJar", () => {
  test("parses expiry and matches domain/path", () => {
    const cookie = parseSetCookie("auth=abc; Domain=.hdu.huitu.zhishulib.com; Path=/; HttpOnly", "https://hdu.huitu.zhishulib.com/");
    expect(cookie?.domain).toBe("hdu.huitu.zhishulib.com");
    const jar = new CookieJar(cookie ? [cookie] : []);
    expect(jar.headerFor("https://hdu.huitu.zhishulib.com/User/Center/baseInfo")).toBe("auth=abc");
    expect(jar.headerFor("https://example.com/")).toBe("");
  });

  test("merges replacement and deletion cookies", () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append("set-cookie", "auth=abc; Path=/");
    jar.merge(headers, "https://hdu.huitu.zhishulib.com/");
    expect(jar.headerFor("https://hdu.huitu.zhishulib.com/")).toBe("auth=abc");
    const expired = new Headers();
    expired.append("set-cookie", "auth=; Max-Age=0; Path=/");
    jar.merge(expired, "https://hdu.huitu.zhishulib.com/");
    expect(jar.headerFor("https://hdu.huitu.zhishulib.com/")).toBe("");
  });
});
