import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRefresh, SessionKeepAlive } from "./session-keep-alive";

const mocks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, getSession: vi.fn().mockResolvedValue({}) }));
vi.mock("react", () => ({
  useState: (initial: () => unknown) => [initial()],
  useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect); },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/events" }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: mocks.getSession } }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); mocks.effects = []; });

it("refreshes long visible edits, skips hidden tabs, and removes its listener and interval", () => {
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", globalThis);
  SessionKeepAlive();
  const cleanups = mocks.effects.map((effect) => effect());
  expect(mocks.getSession).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(15 * 60 * 1000);
  expect(mocks.getSession).toHaveBeenCalledTimes(2);
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(mocks.getSession).toHaveBeenCalledTimes(2);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(mocks.getSession).toHaveBeenCalledTimes(3);
  cleanups.forEach((cleanup) => cleanup?.());
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(15 * 60 * 1000);
  expect(mocks.getSession).toHaveBeenCalledTimes(3);
});

describe("session refresh", () => {
  it("shares a five-minute throttle across rapid navigation and visibility events", () => {
    let now = 0;
    let visible = true;
    const request = vi.fn().mockResolvedValue(null);
    const refresh = createSessionRefresh(request, () => visible, () => now);
    refresh();
    for (let i = 0; i < 100; i++) refresh();
    now = 299_999;
    refresh();
    expect(request).toHaveBeenCalledTimes(1);
    now = 300_000;
    refresh();
    expect(request).toHaveBeenCalledTimes(2);
    visible = false;
    now += 900_000;
    refresh();
    expect(request).toHaveBeenCalledTimes(2);
    visible = true;
    refresh();
    expect(request).toHaveBeenCalledTimes(3);
    now += 900_000;
    refresh();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("throttles failed requests too", async () => {
    let now = 0;
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const refresh = createSessionRefresh(request, () => true, () => now);
    refresh();
    await Promise.resolve();
    refresh();
    expect(request).toHaveBeenCalledTimes(1);
    now = 300_000;
    refresh();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
