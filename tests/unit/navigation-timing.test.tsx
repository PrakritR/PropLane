// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    capture.mockReset();
    getEntriesByType.mockReset();
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
});
