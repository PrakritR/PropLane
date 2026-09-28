import { describe, expect, it } from "vitest";
import {
  portalBackgroundPrefetchEnabled,
  portalIntentPrefetchEnabled,
  portalMobileLinkPrefetchEnabled,
} from "@/lib/portal-nav-prefetch";

describe("portal-nav-prefetch", () => {
  it("leaves route prefetch to explicit navigation intent", () => {
    expect(portalBackgroundPrefetchEnabled()).toBe(false);
    expect(portalMobileLinkPrefetchEnabled()).toBe(false);
    expect(portalIntentPrefetchEnabled()).toBe(process.env.NODE_ENV === "production");
  });
});
