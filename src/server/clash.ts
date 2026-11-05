import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

const DIRECT_TARGET_DOMAINS = ["hdu.huitu.zhishulib.com", "sso.hdu.edu.cn"];
export const MANAGED_DIRECT_RULES = DIRECT_TARGET_DOMAINS.map((domain) => `DOMAIN,${domain},DIRECT`);

const VERGE_DIR_NAME = "io.github.clash-verge-rev.clash-verge-rev";
const PIPE_TIMEOUT_MS = 3_000;

export type VergeEndpoint = { pipe?: string; tcp?: string; secret?: string; mode?: string };
export type ClashDirectStatus = {
  available: boolean;
  enabled: boolean;
  reloaded: boolean;
  mode?: string;
  reason?: string;
};

type VergePaths = { configPath: string; profilesPath: string; profilesDir: string };

// mihomo 的控制接口同时支持命名管道和 TCP。Clash Verge 在 Windows 上默认两者
// 都会配置（pipe 优先），这里把可用的地址都列出来，某个连不上时还能退到另一个。
export function controllerAddresses(endpoint: VergeEndpoint): ControllerAddress[] {
  const addresses: ControllerAddress[] = [];
  const pipe = endpoint.pipe?.trim();
  if (pipe) addresses.push({ unix: pipe });
  const tcp = endpoint.tcp?.trim().replace(/^https?:\/\//i, "");
  const match = tcp ? /^\[?([^\]]+?)\]?:(\d+)$/.exec(tcp) : null;
  const port = match ? Number(match[2]) : NaN;
  if (match && Number.isInteger(port) && port > 0 && port <= 65535) {
    addresses.push({ hostname: match[1]!, port });
  }
  if (addresses.length === 0) throw new Error("Clash 未配置可用的控制接口");
  return addresses;
}

export type ControllerAddress = { unix: string } | { hostname: string; port: number };

// Clash Verge 把 profile 文件（包括 rules override）放在 app_home/profiles/ 下，
// profiles.yaml 里的 file 字段只是文件名，不能直接拼到配置根目录。
export function rulesOverridePath(profilesDir: string, file: string): string {
  return path.join(profilesDir, file);
}

export function parseVergeConfig(text: string): VergeEndpoint {
  const data = parse(text) as Record<string, unknown> | null;
  const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  return {
    pipe: clean(data?.["external-controller-pipe"]),
    tcp: clean(data?.["external-controller"]),
    secret: clean(data?.["secret"]),
    mode: clean(data?.["mode"]),
  };
}

export function findRulesOverrideFile(profilesText: string): string | undefined {
  const data = parse(profilesText) as { current?: string; items?: Array<Record<string, unknown>> } | null;
  const items = data?.items ?? [];
  const current = items.find((item) => item["uid"] === data?.current);
  const rulesUid = (current?.["option"] as Record<string, unknown> | undefined)?.["rules"];
  if (typeof rulesUid !== "string") return undefined;
  const override = items.find((item) => item["uid"] === rulesUid && item["type"] === "rules");
  const file = override?.["file"];
  return typeof file === "string" ? file : undefined;
}

export function applyDirectRulesToOverride(input: unknown, enabled: boolean): Record<string, string[]> {
  const source = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string): string[] => {
    if (!Array.isArray(source[key])) return [];
    return source[key].filter((rule): rule is string => typeof rule === "string" && !MANAGED_DIRECT_RULES.includes(rule));
  };
  const result = { prepend: pick("prepend"), append: pick("append"), delete: pick("delete") };
  if (enabled) result.prepend = [...MANAGED_DIRECT_RULES, ...result.prepend];
  return result;
}

export function applyDirectRulesToRuntime(input: unknown, enabled: boolean): Record<string, unknown> {
  const config = (input ?? {}) as Record<string, unknown>;
  const rules = Array.isArray(config["rules"])
    ? config["rules"].filter((rule): rule is string => typeof rule === "string" && !MANAGED_DIRECT_RULES.includes(rule))
    : [];
  return { ...config, rules: enabled ? [...MANAGED_DIRECT_RULES, ...rules] : rules };
}

export function runtimeHasDirectRules(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  const texts = rules.flatMap((rule) => {
    if (typeof rule === "string") return [rule];
    if (rule && typeof rule === "object") {
      const record = rule as Record<string, unknown>;
      if (typeof record["type"] === "string" && typeof record["payload"] === "string") {
        return [`${record["type"]},${record["payload"]}`];
      }
    }
    return [];
  });
  return MANAGED_DIRECT_RULES.every((managed) => {
    const [type, payload] = managed.split(",");
    return texts.some((text) => text.toLowerCase() === managed.toLowerCase() || text.toLowerCase() === `${type},${payload}`.toLowerCase());
  });
}

export function extractJsonBody(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("mihomo 响应不是 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

function vergePaths(): VergePaths | null {
  const appData = process.env.APPDATA;
  if (process.platform !== "win32" || !appData) return null;
  const dir = path.join(appData, VERGE_DIR_NAME);
  return {
    configPath: path.join(dir, "clash-verge.yaml"),
    profilesPath: path.join(dir, "profiles.yaml"),
    profilesDir: path.join(dir, "profiles"),
  };
}

async function requestOverAddress(address: ControllerAddress, request: string, timeoutMs: number): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      const decoder = new TextDecoder();
      let received = "";
      const socket = {
        data(_socket: unknown, chunk: Uint8Array) { received += decoder.decode(chunk, { stream: true }); },
        end(_socket: unknown) { received += decoder.decode(); resolve(received); },
        error(_socket: unknown, error: unknown) { reject(error instanceof Error ? error : new Error(String(error))); },
      };
      const connecting = "unix" in address
        ? Bun.connect({ unix: address.unix, socket })
        : Bun.connect({ hostname: address.hostname, port: address.port, socket });
      connecting.then((socket) => socket.write(request)).catch(reject);
    }),
    timeoutMs,
    "mihomo 控制请求",
  );
}

async function pipeRequest(endpoint: VergeEndpoint, method: string, requestPath: string, body?: unknown): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = [
    `${method} ${requestPath} HTTP/1.1`,
    "Host: localhost",
    endpoint.secret ? `Authorization: Bearer ${endpoint.secret}` : "",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "Connection: close",
  ].filter(Boolean);
  const request = `${headers.join("\r\n")}\r\n\r\n${payload}`;
  const timeoutMs = method === "PUT" ? 15_000 : PIPE_TIMEOUT_MS;
  const errors: string[] = [];
  for (const address of controllerAddresses(endpoint)) {
    try {
      const raw = await requestOverAddress(address, request, timeoutMs);
      const status = Number(raw.split("\r\n")[0]?.split(" ")[1]) || 0;
      return { status, text: raw };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors[errors.length - 1] || "mihomo 控制接口不可达");
}

async function pipeJson(endpoint: VergeEndpoint, method: string, requestPath: string, body?: unknown): Promise<unknown> {
  const response = await pipeRequest(endpoint, method, requestPath, body);
  if (response.status >= 400) throw new Error(`mihomo 返回 ${response.status}`);
  if (response.status === 204) return undefined;
  return extractJsonBody(response.text);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

async function readRuntimeRules(endpoint: VergeEndpoint): Promise<unknown> {
  const data = await pipeJson(endpoint, "GET", "/rules") as { rules?: unknown } | undefined;
  return data?.rules;
}

async function fileEnabledState(paths: VergePaths): Promise<boolean> {
  const overrideFile = findRulesOverrideFile(await Bun.file(paths.profilesPath).text());
  if (!overrideFile) return false;
  const overrideText = await Bun.file(rulesOverridePath(paths.profilesDir, overrideFile)).text();
  return runtimeHasDirectRules((parse(overrideText) as { prepend?: unknown } | null)?.prepend);
}

export async function getClashDirectStatus(): Promise<ClashDirectStatus> {
  const paths = vergePaths();
  if (!paths) return { available: false, enabled: false, reloaded: false, reason: "仅支持 Windows 上的 Clash Verge" };
  let endpoint: VergeEndpoint;
  try {
    endpoint = parseVergeConfig(await Bun.file(paths.configPath).text());
  } catch {
    return { available: false, enabled: false, reloaded: false, reason: "未找到 Clash Verge 配置" };
  }
  if (!endpoint.pipe && !endpoint.tcp) {
    return { available: false, enabled: false, reloaded: false, reason: "未检测到 Clash 控制接口，请在 Clash Verge 开启外部控制" };
  }
  try {
    const rules = await readRuntimeRules(endpoint);
    const configs = await pipeJson(endpoint, "GET", "/configs") as { mode?: string } | undefined;
    return { available: true, enabled: runtimeHasDirectRules(rules), reloaded: true, mode: configs?.mode };
  } catch {
    let enabled = false;
    try {
      enabled = await fileEnabledState(paths);
    } catch {
      // 控制接口和配置文件都读不到时按“未开启”展示，不要把这个错误抛成 502。
    }
    return { available: true, enabled, reloaded: false, reason: "mihomo 控制接口不可达，显示为配置文件状态" };
  }
}

export async function setClashDirect(enabled: boolean): Promise<ClashDirectStatus> {
  const paths = vergePaths();
  if (!paths) return { available: false, enabled: false, reloaded: false, reason: "仅支持 Windows 上的 Clash Verge" };
  let endpoint: VergeEndpoint;
  let runtimeConfig: Record<string, unknown>;
  let overrideFile: string | undefined;
  try {
    const [configText, profilesText] = await Promise.all([
      Bun.file(paths.configPath).text(),
      Bun.file(paths.profilesPath).text(),
    ]);
    endpoint = parseVergeConfig(configText);
    runtimeConfig = parse(configText) as Record<string, unknown>;
    overrideFile = findRulesOverrideFile(profilesText);
  } catch {
    return { available: false, enabled: false, reloaded: false, reason: "未找到 Clash Verge 配置" };
  }
  if (!endpoint.pipe && !endpoint.tcp) {
    return { available: false, enabled: false, reloaded: false, reason: "未检测到 Clash 控制接口，请在 Clash Verge 开启外部控制" };
  }

  let persisted = false;
  try {
    if (overrideFile) {
      const overridePath = rulesOverridePath(paths.profilesDir, overrideFile);
      const overrideText = await Bun.file(overridePath).text().catch(() => "");
      const patched = applyDirectRulesToOverride(parse(overrideText), enabled);
      await mkdir(paths.profilesDir, { recursive: true });
      await writeFile(overridePath, stringify(patched), "utf8");
    }
    const runtimePatched = applyDirectRulesToRuntime(runtimeConfig, enabled);
    await writeFile(paths.configPath, stringify(runtimePatched), "utf8");
    persisted = true;
  } catch (error) {
    return { available: true, enabled: !enabled, reloaded: false, reason: `写入 Clash 配置失败：${error instanceof Error ? error.message : String(error)}` };
  }

  let reloaded = false;
  let runtimeEnabled = false;
  try {
    await pipeJson(endpoint, "PUT", "/configs?force=true", { path: paths.configPath });
    reloaded = true;
    runtimeEnabled = runtimeHasDirectRules(await readRuntimeRules(endpoint));
  } catch (error) {
    return {
      available: true,
      enabled: runtimeEnabled,
      reloaded: false,
      reason: `配置已保存，但热重载失败（重启 Clash Verge 后生效）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const reason = !persisted && overrideFile === undefined ? "未找到规则覆盖文件，仅对当前运行时生效" : undefined;
  return { available: true, enabled: runtimeEnabled || (!reloaded && enabled), reloaded, mode: endpoint.mode, reason };
}
