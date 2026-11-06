import { afterEach, describe, expect, test, vi } from "vitest";
import { withTimeout } from "../src/web/updater";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  test("resolves when the task finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "超时")).resolves.toBe("ok");
  });

  test("rejects when the update check hangs (GitHub unreachable)", async () => {
    vi.useFakeTimers();
    const pending = new Promise<string>(() => {});
    const result = withTimeout(pending, 15_000, "检查更新超时，请检查网络后重试");
    const assertion = expect(result).rejects.toThrow("检查更新超时");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
