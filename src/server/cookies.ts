export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expiresAt: number | null;
  secure: boolean;
  httpOnly: boolean;
};

function parseExpires(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function parseSetCookie(header: string, requestUrl: string): StoredCookie | null {
  const parts = header.split(";").map((part) => part.trim());
  const [nameValue, ...attributes] = parts;
  const separator = nameValue.indexOf("=");
  if (separator <= 0) return null;
  const url = new URL(requestUrl);
  const cookie: StoredCookie = {
    name: nameValue.slice(0, separator),
    value: nameValue.slice(separator + 1),
    domain: url.hostname,
    path: "/",
    expiresAt: null,
    secure: false,
    httpOnly: false,
  };
  for (const attribute of attributes) {
    const [rawKey, ...rawValue] = attribute.split("=");
    const key = rawKey.toLowerCase();
    const value = rawValue.join("=");
    if (key === "domain" && value) cookie.domain = value.replace(/^\./, "").toLowerCase();
    if (key === "path" && value) cookie.path = value;
    if (key === "expires") cookie.expiresAt = parseExpires(value);
    if (key === "max-age") cookie.expiresAt = Date.now() + Number(value) * 1000;
    if (key === "secure") cookie.secure = true;
    if (key === "httponly") cookie.httpOnly = true;
  }
  return cookie;
}

export class CookieJar {
  constructor(private cookies: StoredCookie[] = []) {}

  get all(): StoredCookie[] {
    return this.cookies.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > Date.now());
  }

  headerFor(urlString: string): string {
    const url = new URL(urlString);
    return this.all
      .filter((cookie) =>
        (url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`)) &&
        url.pathname.startsWith(cookie.path) &&
        (!cookie.secure || url.protocol === "https:"))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  clear(): void {
    this.cookies = [];
  }

  merge(headers: Headers, requestUrl: string): boolean {
    const setCookies = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") || "").split(/,(?=[^;]+=[^;]+)/g).filter(Boolean);
    let changed = false;
    for (const header of setCookies) {
      const parsed = parseSetCookie(header, requestUrl);
      if (!parsed) continue;
      this.cookies = this.cookies.filter((cookie) =>
        !(cookie.name === parsed.name && cookie.domain === parsed.domain && cookie.path === parsed.path));
      if (!/^$/.test(parsed.value) && (parsed.expiresAt === null || parsed.expiresAt > Date.now())) this.cookies.push(parsed);
      changed = true;
    }
    return changed;
  }
}
