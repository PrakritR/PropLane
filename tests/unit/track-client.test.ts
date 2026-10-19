import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

// Mock the posthog-js singleton so the helper has a capture() to forward to.
// vi.mock is hoisted, so build the spy via vi.hoisted to keep it in scope.
const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { capture } }));

import { track } from "@/lib/analytics/track-client";

describe("track-client", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { hostname: "proplane.ai" } });
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "test-token");
  });
  // Reset after each test so a per-test mockImplementation (e.g. the throwing
  // one below) never leaks into file teardown, which vitest surfaces as an error.
  afterEach(() => { capture.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("forwards event name and properties to posthog.capture", async () => {
    track("charge_created", { kind: "rent", amount: 1200 });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith("charge_created", { kind: "rent", amount: 1200 }));
  });

  it("works with no properties", async () => {
    track("assistant_opened");
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith("assistant_opened", undefined));
  });

  it("never throws when posthog.capture blows up (analytics must not break the UI)", async () => {
    capture.mockImplementation(() => {
      throw new Error("posthog not loaded");
    });
    let threw = false;
    try {
      track("feedback_submitted", { role: "manager" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
  });

  it.each(["localhost", "staging-prop-lane.space", "preview.vercel.app"])("does not capture on %s", async (hostname) => {
    vi.stubGlobal("window", { location: { hostname } });
    track("assistant_opened");
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not capture without a browser or project token", async () => {
    vi.stubGlobal("window", undefined);
    track("assistant_opened");
    vi.stubGlobal("window", { location: { hostname: "proplane.ai" } });
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "");
    track("assistant_opened");
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
  });
});
