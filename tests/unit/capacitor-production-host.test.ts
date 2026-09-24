import { describe, expect, it } from "vitest";
import {
  CAPACITOR_ALLOW_NAVIGATION_HOSTS,
  CAPACITOR_PRODUCTION_SERVER_ORIGIN,
} from "../../capacitor.config";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";

describe("Capacitor production host (domain cutover)", () => {
  it("defaults the shell to the canonical PRODUCTION_APP_ORIGIN", () => {
    expect(CAPACITOR_PRODUCTION_SERVER_ORIGIN).toBe("https://proplane.ai");
    expect(CAPACITOR_PRODUCTION_SERVER_ORIGIN).toBe(PRODUCTION_APP_ORIGIN);
  });

  it("allow-lists proplane.ai so a prop-lane 308 stays in the WebView", () => {
    expect(CAPACITOR_ALLOW_NAVIGATION_HOSTS).toContain("proplane.ai");
    expect(CAPACITOR_ALLOW_NAVIGATION_HOSTS).toContain("www.proplane.ai");
    // Redirect source + legacy Axis — residual deep links must not eject.
    expect(CAPACITOR_ALLOW_NAVIGATION_HOSTS).toContain("prop-lane.space");
    expect(CAPACITOR_ALLOW_NAVIGATION_HOSTS).toContain("www.prop-lane.space");
    expect(CAPACITOR_ALLOW_NAVIGATION_HOSTS).toContain("axis-seattle-housing.com");
  });
});
