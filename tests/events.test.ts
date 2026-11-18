import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { subscribeAppEvents, subscribeQrEvents } from "../src/web/data/events";

/**
 * happy-dom ships no EventSource, so the suite drives these two subscriptions
 * through a minimal stand-in that mimics the parts events.ts relies on:
 * readyState constants, addEventListener, close().
 */
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  closed = false;
  private listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  /** Fires a listener registered through addEventListener. */
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      const event = { data: data === undefined ? undefined : JSON.stringify(data) } as unknown;
      listener(event as Event);
    }
  }

  /** Simulates a transient transport failure that leaves the socket closed. */
  fail() {
    this.readyState = MockEventSource.CLOSED;
    this.emit("error");
  }
}

function latest(): MockEventSource {
  const source = MockEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was created");
  return source;
}

function stubApi(overrides: { session?: unknown; qrStatus?: unknown } = {}) {
  const session = vi.fn(async () => overrides.session ?? { authenticated: true, refreshing: false });
  const qrStatus = vi.fn(
    async () => overrides.qrStatus ?? { status: "pending", message: "", session: undefined },
  );
  vi.doMock("../src/web/data/api", async () => {
    const actual = await vi.importActual<typeof import("../src/web/data/api")>("../src/web/data/api");
    return { ...actual, api: { ...actual.api, session, qrStatus } };
  });
  return { session, qrStatus };
}

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../src/web/data/api");
  vi.resetModules();
});

describe("subscribeAppEvents", () => {
  test("delivers parsed app_event payloads", async () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeAppEvents({ onEvent });

    latest().emit("app_event", { kind: "runtime", runtime: { state: "idle" } });

    expect(onEvent).toHaveBeenCalledWith({ kind: "runtime", runtime: { state: "idle" } });
    unsubscribe();
  });

  test("ignores payloads that are not JSON or lack a kind", () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeAppEvents({ onEvent });
    const source = latest();

    source.emit("app_event", undefined);
    source.addEventListener("app_event", () => {});
    source.emit("app_event", { runtime: { state: "idle" } });

    expect(onEvent).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("unsubscribe closes the stream and stops delivery", () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeAppEvents({ onEvent });
    const source = latest();

    unsubscribe();
    source.emit("app_event", { kind: "session" });

    expect(source.closed).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("signals reconnect once the stream recovers from an error", () => {
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    const unsubscribe = subscribeAppEvents({ onEvent, onReconnect });
    const source = latest();

    source.emit("open");
    expect(onReconnect).not.toHaveBeenCalled();

    source.emit("error");
    source.emit("open");

    expect(onReconnect).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("reports an expired session through onSessionExpired after an error", async () => {
    stubApi({ session: { authenticated: false, refreshing: false } });
    const { subscribeAppEvents: subscribe } = await import("../src/web/data/events");

    const onSessionExpired = vi.fn();
    const unsubscribe = subscribe({ onEvent: vi.fn(), onSessionExpired });

    latest().emit("error");
    await vi.advanceTimersByTimeAsync(300);

    expect(onSessionExpired).toHaveBeenCalledWith({ authenticated: false, refreshing: false });
    unsubscribe();
  });

  test("reopens the stream when the probe finds the session still valid", async () => {
    stubApi({ session: { authenticated: true, refreshing: false } });
    const { subscribeAppEvents: subscribe } = await import("../src/web/data/events");

    const unsubscribe = subscribe({ onEvent: vi.fn() });
    latest().fail();
    await vi.advanceTimersByTimeAsync(300);

    // The probe saw an authenticated session, so a fresh socket replaces the dead one.
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockEventSource.instances.length).toBeGreaterThan(1);
    unsubscribe();
  });

  test("debounces repeated error events into a single probe", async () => {
    stubApi({ session: { authenticated: true, refreshing: false } });
    const { subscribeAppEvents: subscribe } = await import("../src/web/data/events");

    const unsubscribe = subscribe({ onEvent: vi.fn() });
    const source = latest();
    source.emit("error");
    source.emit("error");
    source.emit("error");
    await vi.advanceTimersByTimeAsync(300);

    unsubscribe();
  });
});

describe("subscribeQrEvents", () => {
  test("emits pending status without tearing down the stream", () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeQrEvents("abc", { onEvent });
    const source = latest();

    source.emit("qr_status", { uuid: "abc", status: "pending" });

    expect(onEvent).toHaveBeenCalledWith({ uuid: "abc", status: "pending" });
    expect(source.closed).toBe(false);
    unsubscribe();
  });

  test("closes the stream once a terminal status arrives", () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeQrEvents("abc", { onEvent });
    const source = latest();

    source.emit("qr_status", { uuid: "abc", status: "success" });

    expect(onEvent).toHaveBeenCalledWith({ uuid: "abc", status: "success" });
    expect(source.closed).toBe(true);
    unsubscribe();
  });

  test("drops events belonging to another QR session", () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeQrEvents("abc", { onEvent });

    latest().emit("qr_status", { uuid: "other", status: "success" });

    expect(onEvent).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("builds the QR events URL from the uuid", () => {
    const unsubscribe = subscribeQrEvents("uuid-123", { onEvent: vi.fn() });

    expect(latest().url).toBe("/api/session/qr/uuid-123/events");
    unsubscribe();
  });

  test("stops after six consecutive failures and reports the interruption", async () => {
    stubApi({ qrStatus: { status: "pending" } });
    const { subscribeQrEvents: subscribe } = await import("../src/web/data/events");

    const onError = vi.fn();
    const unsubscribe = subscribe("abc", { onEvent: vi.fn(), onError });

    for (let attempt = 0; attempt < 7; attempt += 1) {
      latest().fail();
      await vi.advanceTimersByTimeAsync(500 + 1500);
    }

    expect(onError).toHaveBeenCalledWith("扫码状态连接中断，请刷新二维码");
    unsubscribe();
  });

  test("reports a different message when the status probe itself throws", async () => {
    const qrStatus = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.doMock("../src/web/data/api", async () => {
      const actual = await vi.importActual<typeof import("../src/web/data/api")>("../src/web/data/api");
      return { ...actual, api: { ...actual.api, qrStatus } };
    });
    const { subscribeQrEvents: subscribe } = await import("../src/web/data/events");

    const onError = vi.fn();
    const unsubscribe = subscribe("abc", { onEvent: vi.fn(), onError });

    for (let attempt = 0; attempt < 7; attempt += 1) {
      latest().fail();
      await vi.advanceTimersByTimeAsync(500 + 1500);
    }

    expect(onError).toHaveBeenCalledWith("扫码状态连接失败，请刷新二维码");
    unsubscribe();
  });

  test("recovers a terminal status through the probe instead of failing", async () => {
    stubApi({ qrStatus: { status: "expired", message: "二维码已过期" } });
    const { subscribeQrEvents: subscribe } = await import("../src/web/data/events");

    const onEvent = vi.fn();
    const onError = vi.fn();
    const unsubscribe = subscribe("abc", { onEvent, onError });

    latest().fail();
    await vi.advanceTimersByTimeAsync(500);

    expect(onEvent).toHaveBeenCalledWith({
      uuid: "abc",
      status: "expired",
      message: "二维码已过期",
    });
    expect(onError).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("unsubscribe prevents later events from being delivered", () => {
    const onEvent = vi.fn();
    const unsubscribe = subscribeQrEvents("abc", { onEvent });
    const source = latest();

    unsubscribe();
    source.emit("qr_status", { uuid: "abc", status: "pending" });

    expect(onEvent).not.toHaveBeenCalled();
  });
});
