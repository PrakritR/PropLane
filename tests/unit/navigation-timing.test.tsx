// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capture, getEntriesByType } = vi.hoisted(() => ({
  capture: vi.fn(),
  getEntriesByType: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: { capture } }));
vi.mock("@/lib/analytics/browser-performance", () => ({
  analyticsRouteFromUrl: () => "/original-navigation",
  isProductionAnalyticsHost: () => true,
  navigationTimingSnapshot: () => ({ duration: 120, responseStart: 15, domContentLoaded: 80 }),
  nativeRuntimeMetadata: () => ({ axis_runtime: "web" }),
}));

import { NavigationTiming } from "@/components/analytics/navigation-timing";

describe("NavigationTiming", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "test-token"));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    capture.mockReset();
    getEntriesByType.mockReset();
    vi.unstubAllEnvs();
  });

  it("waits for load and cancels its deferred report when unmounted", () => {
    vi.useFakeTimers();
    Object.defineProperty(window.performance, "getEntriesByType", {
      configurable: true,
      value: getEntriesByType,
    });
    Object.defineProperty(document, "readyState", { configurable: true, value: "loading" });
    getEntriesByType.mockReturnValue([{ name: "https://proplane.ai/original" }]);

    const view = render(<NavigationTiming />);
    expect(capture).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    view.unmount();
    vi.runAllTimers();

    expect(capture).not.toHaveBeenCalled();
  });

  it("reports the same navigation fields once through the lazy event helper", async () => {
    Object.defineProperty(window.performance, "getEntriesByType", { configurable: true, value: getEntriesByType });
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    getEntriesByType.mockReturnValue([{ name: "https://proplane.ai/original" }]);
    const view = render(<NavigationTiming />);
    await waitFor(() => expect(capture).toHaveBeenCalledWith("navigation_timing", {
      duration: 120, responseStart: 15, domContentLoaded: 80, pathname: "/original-navigation", axis_runtime: "web",
    }));
    view.rerender(<NavigationTiming />);
    expect(capture).toHaveBeenCalledOnce();
  });
});
