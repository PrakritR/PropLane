import type { Page } from "@playwright/test";
import { errors } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ poll: vi.fn() }));
vi.mock("@playwright/test", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playwright/test")>();
  return { ...actual, expect: { poll: mocks.poll } };
});
vi.mock("../fixtures", () => ({ E2E_ACCOUNTS: {} }));
import { establishActivePortal } from "../helpers/auth";

const destination = "/resident/dashboard";
const chooser = "/auth/choose-portal";

function setup() {
  const state = { pathname: "/auth/continue", closed: false, clickSettled: false };
  const click = vi.fn(async () => {
    state.pathname = destination;
    state.clickSettled = true;
  });
  const first = vi.fn(() => ({ click }));
  const page = {
    url: vi.fn(() => `https://app.example.test${state.pathname}`),
    goto: vi.fn(async () => { state.pathname = chooser; }),
    getByRole: vi.fn(() => ({ first })),
    waitForFunction: vi.fn(async (): Promise<void> => {}),
    on: vi.fn(),
    off: vi.fn(),
    isClosed: vi.fn(() => state.closed),
  };
  return { state, click, first, page, run: () => establishActivePortal(page as unknown as Page, "resident", destination) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A focused adapter: the helper's real final assertion samples the current
  // pathname, while Vitest checks the same matcher without a browser or timers.
  mocks.poll.mockImplementation((sample: () => string) => ({
    toMatch: async (matcher: RegExp) => { expect(sample()).toMatch(matcher); },
  }));
});

describe("establishActivePortal", () => {
  it("waits for the single bounded click to settle when auto-navigation replaces its chooser", async () => {
    const f = setup();
    let rejectClick!: (reason: Error) => void;
    const pendingClick = new Promise<void>((_resolve, reject) => { rejectClick = reject; });
    f.click.mockImplementation(async () => {
      try { await pendingClick; } finally { f.state.clickSettled = true; }
    });
    let completed = false;
    const result = f.run().then(() => { completed = true; });
    await vi.waitFor(() => expect(f.click).toHaveBeenCalledTimes(1));
    f.state.pathname = destination;
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(mocks.poll).not.toHaveBeenCalled();
    rejectClick(new errors.TimeoutError("chooser document replaced"));
    await result;
    expect(f.state.clickSettled).toBe(true);
    expect(f.click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 });
    expect(mocks.poll).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 45_000 });
    expect(f.page.off).toHaveBeenCalledWith("response", f.page.on.mock.calls[0]?.[1]);
  });

  it("clicks only the requested role once for normal manual selection", async () => {
    const f = setup();
    await f.run();
    expect(f.page.goto).toHaveBeenCalledWith(`${chooser}?next=${encodeURIComponent(destination)}`, { waitUntil: "domcontentloaded" });
    expect(f.page.getByRole).toHaveBeenCalledExactlyOnceWith("button", { name: /^Resident\b/ });
    expect(f.first).toHaveBeenCalledTimes(1);
    expect(f.click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
  });

  it("does not click when single-role navigation wins before the second URL check", async () => {
    const f = setup();
    f.page.waitForFunction.mockImplementation(async () => { f.state.pathname = destination; });
    await f.run();
    expect(f.click).not.toHaveBeenCalled();
  });

  it.each([
    ["refused selection on the chooser", chooser],
    ["another portal", "/portal/dashboard"],
    ["a lookalike destination prefix", "/resident/dashboard-other"],
  ])("preserves the original timeout for %s", async (_label, pathname) => {
    const f = setup();
    const failure = new errors.TimeoutError("requested role did not become selectable");
    f.click.mockImplementation(async () => { f.state.pathname = pathname; throw failure; });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.click).toHaveBeenCalledTimes(1);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it("does not conceal an unrelated click failure even at the requested destination", async () => {
    const f = setup();
    const failure = new Error("browser transport failed");
    f.click.mockImplementation(async () => { f.state.pathname = destination; throw failure; });
    await expect(f.run()).rejects.toBe(failure);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it("does not accept an Error merely named TimeoutError", async () => {
    const f = setup();
    const failure = Object.assign(new Error("not a Playwright timeout"), { name: "TimeoutError" });
    f.click.mockImplementation(async () => { f.state.pathname = destination; throw failure; });
    await expect(f.run()).rejects.toBe(failure);
  });

  it("rejects the original timeout if the page closed despite its last requested URL", async () => {
    const f = setup();
    const failure = new errors.TimeoutError("page disappeared");
    f.click.mockImplementation(async () => { f.state.pathname = destination; f.state.closed = true; throw failure; });
    await expect(f.run()).rejects.toBe(failure);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it("requires the final destination after a successful click with no navigation", async () => {
    const f = setup();
    f.click.mockResolvedValue(undefined);
    await expect(f.run()).rejects.toThrow();
    expect(f.click).toHaveBeenCalledTimes(1);
    expect(mocks.poll).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 45_000 });
  });
});
