import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ effect: undefined as (() => (() => void)) | undefined, getSession: vi.fn().mockResolvedValue({}) }));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void)) => { mocks.effect = effect; } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/events" }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: mocks.getSession } }));
import { SessionKeepAlive } from "./session-keep-alive";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("refreshes on long visible edits and return to the tab, skips hidden tabs, and cleans up", () => {
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", globalThis);
  SessionKeepAlive();
  const cleanup = mocks.effect!();
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
  cleanup();
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(15 * 60 * 1000);
  expect(mocks.getSession).toHaveBeenCalledTimes(3);
});
