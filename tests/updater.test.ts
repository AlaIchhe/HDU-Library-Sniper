import { afterEach, describe, expect, test, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

import {
  applyDownloadEvent,
  commitUpdateProgress,
  emptyTick,
  getUpdateProgress,
  percentOf,
  subscribeUpdateProgress,
} from "../src/web/update-state";

afterEach(() => {
  commitUpdateProgress({ phase: "idle", percent: 0, received: 0, total: 0 });
});

describe("percentOf", () => {
  test("returns 0 when the server sends no content length", () => {
    expect(percentOf(1024, 0)).toBe(0);
  });

  test("floors the ratio so the bar never overshoots", () => {
    expect(percentOf(10, 100)).toBe(10);
    expect(percentOf(105, 1000)).toBe(10);
    expect(percentOf(1000, 1000)).toBe(100);
  });

  test("clamps a chunk that pushes past the declared length", () => {
    expect(percentOf(2000, 1000)).toBe(100);
    expect(percentOf(100, -1)).toBe(0);
  });
});

describe("applyDownloadEvent", () => {
  test("Started resets the counter and adopts the content length", () => {
    const started: DownloadEvent = { event: "Started", data: { contentLength: 500 } };
    expect(applyDownloadEvent({ received: 90, total: 500, percent: 18 }, started)).toEqual({
      received: 0,
      total: 500,
      percent: 0,
    });
  });

  test("Started without content length keeps the bar indeterminate", () => {
    const started: DownloadEvent = { event: "Started", data: {} };
    expect(applyDownloadEvent(emptyTick, started)).toEqual({ received: 0, total: 0, percent: 0 });
  });

  test("Progress carries a delta, so chunks accumulate", () => {
    let tick = applyDownloadEvent(emptyTick, { event: "Started", data: { contentLength: 200 } });
    tick = applyDownloadEvent(tick, { event: "Progress", data: { chunkLength: 50 } });
    tick = applyDownloadEvent(tick, { event: "Progress", data: { chunkLength: 50 } });
    expect(tick).toEqual({ received: 100, total: 200, percent: 50 });
  });

  test("Finished leaves the tick untouched, it is handled by the caller", () => {
    const before = { received: 120, total: 200, percent: 60 };
    expect(applyDownloadEvent(before, { event: "Finished" })).toBe(before);
  });
});

describe("update progress store", () => {
  test("starts idle", () => {
    expect(getUpdateProgress().phase).toBe("idle");
  });

  test("notifies subscribers and merges patches", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUpdateProgress(listener);
    commitUpdateProgress({ phase: "available", version: "2.0.30" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getUpdateProgress()).toMatchObject({ phase: "available", version: "2.0.30" });

    commitUpdateProgress({ percent: 42 });
    expect(getUpdateProgress()).toMatchObject({ phase: "available", version: "2.0.30", percent: 42 });
    unsubscribe();
  });

  test("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    subscribeUpdateProgress(listener)();
    commitUpdateProgress({ phase: "downloading" });
    expect(listener).not.toHaveBeenCalled();
  });
});
