import { describe, expect, it } from "vitest";

import {
  analyticsRouteFromUrl,
  isProductionAnalyticsHost,
  nativeRuntimeMetadata,
  prepareBrowserAnalyticsEvent,
} from "@/lib/analytics/browser-performance";

describe("browser performance analytics", () => {
  it("only enables browser analytics for canonical production hosts", () => {
    expect(isProductionAnalyticsHost("proplane.ai")).toBe(true);
    expect(isProductionAnalyticsHost("www.proplane.ai")).toBe(true);
    expect(isProductionAnalyticsHost("prop-lane.space")).toBe(true);
    expect(isProductionAnalyticsHost("localhost:3000")).toBe(false);
    expect(isProductionAnalyticsHost("staging-prop-lane.space")).toBe(false);
    expect(isProductionAnalyticsHost("proplane-git-feature.vercel.app")).toBe(false);
  });

  it("attributes the existing web-vitals event to its sanitized navigation route", () => {
    const event = {
      event: "$web_vitals",
      properties: {
        $current_url: "https://proplane.ai/portal/inbox?thread=private",
        $web_vitals_LCP_event: {
          navigationURL: "https://proplane.ai/portal?access_token=secret",
        },
      },
    };

    const result = prepareBrowserAnalyticsEvent(event, "ios");
    expect(result?.event).toBe("$web_vitals");
    expect(result?.properties).toMatchObject({
      $current_url: "https://proplane.ai/portal",
      $pathname: "/portal",
      axis_web_vitals_navigation_path: "/portal",
      axis_runtime: "native-ios",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not change ordinary event URLs or create a second vitals event", () => {
    const event = {
      event: "assistant_opened",
      properties: { $current_url: "https://proplane.ai/portal?tab=assistant" },
    };

    const result = prepareBrowserAnalyticsEvent(event, null);
    expect(result).toEqual({
      event: "assistant_opened",
      properties: {
        $current_url: "https://proplane.ai/portal?tab=assistant",
        axis_runtime: "web",
      },
    });
    expect(result?.event).not.toBe("$web_vitals");
  });

  it("uses only a coarse native runtime category", () => {
    expect(nativeRuntimeMetadata("android")).toEqual({ axis_runtime: "native-android" });
    expect(nativeRuntimeMetadata("unknown-bridge")).toEqual({ axis_runtime: "native" });
  });

  it("strips queries and redacts token-bearing paths before timing telemetry", () => {
    expect(analyticsRouteFromUrl("https://proplane.ai/portal?email=person@example.com")).toBe("/portal");
    expect(analyticsRouteFromUrl("https://proplane.ai/invite/secret-value")).toBe("/invite/[redacted]");
  });
});
