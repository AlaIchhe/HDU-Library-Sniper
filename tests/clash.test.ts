import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  MANAGED_DIRECT_RULES,
  applyDirectRulesToOverride,
  applyDirectRulesToRuntime,
  controllerAddresses,
  extractJsonBody,
  findRulesOverrideFile,
  parseVergeConfig,
  rulesOverridePath,
  runtimeHasDirectRules,
} from "../src/server/clash";

describe("parseVergeConfig", () => {
  test("extracts pipe endpoint, secret and mode", () => {
    const config = parseVergeConfig(`
mode: global
external-controller: ''
secret: set-your-secret
external-controller-pipe: \\\\.\\pipe\\verge-mihomo
`);
    expect(config.pipe).toBe("\\\\.\\pipe\\verge-mihomo");
    expect(config.tcp).toBeUndefined();
    expect(config.secret).toBe("set-your-secret");
    expect(config.mode).toBe("global");
  });
});

describe("findRulesOverrideFile", () => {
  test("resolves the rules override file of the current profile", () => {
    const profiles = `
current: RFr1OYGjUQYj
items:
- uid: mDpYIdN4ATT7
  type: merge
  file: mDpYIdN4ATT7.yaml
- uid: RFr1OYGjUQYj
  type: remote
  file: RFr1OYGjUQYj.yaml
  option:
    rules: rJM592aadRw1
- uid: rJM592aadRw1
  type: rules
  file: rJM592aadRw1.yaml
`;
    expect(findRulesOverrideFile(profiles)).toBe("rJM592aadRw1.yaml");
  });

  test("returns undefined when the profile has no rules override", () => {
    const profiles = `
current: none
items:
- uid: none
  type: remote
  file: none.yaml
`;
    expect(findRulesOverrideFile(profiles)).toBeUndefined();
  });
});

describe("controllerAddresses", () => {
  test("prefers the named pipe and falls back to TCP", () => {
    expect(controllerAddresses({ pipe: "\\\\.\\pipe\\verge-mihomo", tcp: "127.0.0.1:9097" })).toEqual([
      { unix: "\\\\.\\pipe\\verge-mihomo" },
      { hostname: "127.0.0.1", port: 9097 },
    ]);
    expect(controllerAddresses({ tcp: "http://127.0.0.1:9097" })).toEqual([{ hostname: "127.0.0.1", port: 9097 }]);
    expect(controllerAddresses({ tcp: "192.168.1.2:9097" })).toEqual([{ hostname: "192.168.1.2", port: 9097 }]);
  });

  test("rejects endpoints without a usable address", () => {
    expect(() => controllerAddresses({})).toThrow("Clash 未配置可用的控制接口");
    expect(() => controllerAddresses({ tcp: "127.0.0.1" })).toThrow();
  });
});

describe("rulesOverridePath", () => {
  test("resolves inside the Verge profiles directory", () => {
    const dir = path.join("AppData", "verge", "profiles");
    expect(rulesOverridePath(dir, "rules.yaml")).toBe(path.join(dir, "rules.yaml"));
  });
});

describe("applyDirectRulesToOverride", () => {
  test("prepends managed rules while keeping user rules", () => {
    const result = applyDirectRulesToOverride({ prepend: ["DOMAIN,user.example.com,DIRECT"], append: ["MATCH,Proxy"] }, true);
    expect(result.prepend).toEqual([...MANAGED_DIRECT_RULES, "DOMAIN,user.example.com,DIRECT"]);
    expect(result.append).toEqual(["MATCH,Proxy"]);
    expect(result.delete).toEqual([]);
  });

  test("disable removes managed rules but keeps the rest", () => {
    const input = { prepend: [...MANAGED_DIRECT_RULES, "DOMAIN,user.example.com,DIRECT"], append: ["MATCH,Proxy"] };
    const result = applyDirectRulesToOverride(input, false);
    expect(result.prepend).toEqual(["DOMAIN,user.example.com,DIRECT"]);
    expect(result.append).toEqual(["MATCH,Proxy"]);
  });
});

describe("applyDirectRulesToRuntime", () => {
  test("does not mutate the input and updates rules only in the copy", () => {
    const input = { mode: "global", rules: ["MATCH,Proxy"] };
    const result = applyDirectRulesToRuntime(input, true);
    expect(input.rules).toEqual(["MATCH,Proxy"]);
    expect(result.rules).toEqual([...MANAGED_DIRECT_RULES, "MATCH,Proxy"]);
  });
});

describe("runtimeHasDirectRules", () => {
  test("requires every managed rule to be present", () => {
    expect(runtimeHasDirectRules([...MANAGED_DIRECT_RULES])).toBe(true);
    expect(runtimeHasDirectRules([MANAGED_DIRECT_RULES[0]!])).toBe(false);
    expect(runtimeHasDirectRules(undefined)).toBe(false);
  });

  test("matches mihomo runtime rule objects case-insensitively", () => {
    const rules = MANAGED_DIRECT_RULES.map((rule) => {
      const [type, payload, proxy] = rule.split(",");
      return { type: "Domain", payload, proxy };
    });
    expect(runtimeHasDirectRules(rules)).toBe(true);
  });
});

describe("extractJsonBody", () => {
  test("extracts JSON from a chunked HTTP response", () => {
    const raw = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n85bf\r\n{"rules":[{"payload":"x"}]}\n\r\n0\r\n\r\n';
    expect(extractJsonBody(raw)).toEqual({ rules: [{ payload: "x" }] });
  });
});
