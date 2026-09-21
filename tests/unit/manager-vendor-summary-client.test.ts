import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateManagerVendorSummary, loadManagerVendorSummary, resetManagerVendorSummaryCache } from "@/lib/manager-vendor-summary-client";

afterEach(() => {
  resetManagerVendorSummaryCache();
  vi.unstubAllGlobals();
});

describe("manager vendor summary client cache", () => {
  it("coalesces same-viewer reads while keeping different viewers isolated", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ jobs: [] }) }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    await Promise.all([
      loadManagerVendorSummary("manager-a", "vendor-1"),
      loadManagerVendorSummary("manager-a", "vendor-1"),
      loadManagerVendorSummary("manager-b", "vendor-1"),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(["/api/portal-vendors/vendor-1/summary", "/api/portal-vendors/vendor-1/summary"]);
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({ credentials: "include", cache: "no-store" });
  });

  it("refetches an invalidated scoped entry", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ jobs: [] }) }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    await loadManagerVendorSummary("manager-a", "vendor-1");
    invalidateManagerVendorSummary("manager-a", "vendor-1");
    await loadManagerVendorSummary("manager-a", "vendor-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
