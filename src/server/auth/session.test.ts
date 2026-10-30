import { beforeEach, expect, it, vi } from "vitest";
import { requireSession } from "./session";

const mocks = vi.hoisted(() => ({ headers: new Headers(), getSession: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(path); } }));
vi.mock("./auth", () => ({ getAuth: () => ({ api: { getSession: mocks.getSession } }) }));

beforeEach(() => {
  mocks.headers = new Headers({ "x-next-path": "/profile?tab=sessions" });
  mocks.getSession.mockResolvedValue(null);
});

it("keeps next without claiming a first-time visitor's session ended", async () => {
  await expect(requireSession()).rejects.toThrow("/login?next=%2Fprofile%3Ftab%3Dsessions");
});

it("marks an invalid cookie session as ended and keeps next", async () => {
  mocks.headers.set("cookie", "better-auth.session_token=expired");
  await expect(requireSession()).rejects.toThrow("/login?next=%2Fprofile%3Ftab%3Dsessions&sessionEnded=1");
});

it("also marks an ended session on the default events page", async () => {
  mocks.headers.set("x-next-path", "/events");
  mocks.headers.set("cookie", "better-auth.session_token=expired");
  await expect(requireSession()).rejects.toThrow("/login?next=%2Fevents&sessionEnded=1");
});

it("returns a valid session", async () => {
  const session = { user: { id: "admin", disabledAt: null }, session: { id: "session" } };
  mocks.getSession.mockResolvedValue(session);
  expect(await requireSession()).toEqual(session);
});
