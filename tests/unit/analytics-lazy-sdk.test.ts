import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ idle: vi.fn(), loaded: vi.fn(), init: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/run-when-idle", () => ({ runWhenIdle: mocks.idle }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal("window", { location: { hostname: "proplane.ai", pathname: "/" } });
  vi.stubGlobal("document", { documentElement: { getAttribute: () => "ios" } });
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "test-token");
  vi.doMock("posthog-js", () => { mocks.loaded(); return { default: { init: mocks.init, capture: mocks.capture } }; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.doUnmock("posthog-js"); });

describe("PostHog code loads only at the analytics activation point", () => {
  it("does not download the SDK until the existing idle callback runs", async () => {
    await import("../../instrumentation-client");
    expect(mocks.loaded).not.toHaveBeenCalled();
    expect(mocks.idle).toHaveBeenCalledOnce();
    mocks.idle.mock.calls[0][0]();
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
    expect(mocks.capture).not.toHaveBeenCalled(); // SDK owns the single initial pageview.
    expect(mocks.init).toHaveBeenCalledWith("test-token", expect.objectContaining({ api_host: "/ingest", ui_host: "https://us.posthog.com", defaults: "2026-01-30", capture_exceptions: true }));
    const config = mocks.init.mock.calls[0][1];
    const event = config.before_send({ event: "$pageview", properties: { $current_url: "https://proplane.ai/auth/confirm?token_hash=private" } });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(event.properties.axis_runtime).toBe("native-ios");
  });

  it("starts loading immediately on auth routes, without waiting for idle", async () => {
    vi.stubGlobal("window", { location: { hostname: "proplane.ai", pathname: "/auth/sign-in" } });
    await import("../../instrumentation-client");
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
    expect(mocks.idle).not.toHaveBeenCalled();
  });

  it.each(["localhost", "staging-prop-lane.space", "preview.vercel.app"])("does not download or initialize on %s", async (hostname) => {
    vi.stubGlobal("window", { location: { hostname, pathname: "/" } });
    await import("../../instrumentation-client");
    const { track } = await import("@/lib/analytics/track-client");
    track("assistant_opened");
    expect(mocks.loaded).not.toHaveBeenCalled();
    expect(mocks.idle).not.toHaveBeenCalled();
  });

  it("does not load without a project token", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "");
    await import("../../instrumentation-client");
    const { track } = await import("@/lib/analytics/track-client");
    track("assistant_opened");
    expect(mocks.loaded).not.toHaveBeenCalled();
  });

  it("does not load the SDK merely by importing the event helper", async () => {
    const { track } = await import("@/lib/analytics/track-client");
    expect(mocks.loaded).not.toHaveBeenCalled();
    track("assistant_opened", { surface: "demo" });
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledWith("assistant_opened", { surface: "demo" }));
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("contains SDK delivery failure without rejecting the page module or event caller", async () => {
    vi.doMock("posthog-js", () => { throw new Error("blocked SDK"); });
    vi.stubGlobal("window", { location: { hostname: "proplane.ai", pathname: "/auth/sign-in" } });
    await expect(import("../../instrumentation-client")).resolves.toBeDefined();
    const { track } = await import("@/lib/analytics/track-client");
    expect(() => track("assistant_opened")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("keeps every formerly eager root edge free of a static SDK import", () => {
    for (const file of ["instrumentation-client.ts", "src/components/analytics/navigation-timing.tsx", "src/lib/analytics/track-client.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/import\s+posthog\s+from\s+["']posthog-js/);
    }
  });
});
