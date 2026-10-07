import { describe, expect, it, vi } from "vitest";

class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { renderPortalSection } = await import("@/lib/render-portal-section");
const { resolveVendorSettingsTab } = await import("@/lib/portals/vendor-settings-pages");

async function target(tabParts?: string[], searchParams?: Record<string, string>) {
  try {
    await renderPortalSection("vendor", "settings", tabParts, searchParams);
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error("expected redirect");
}

describe("/vendor/settings redirect", () => {
  it("bare settings -> /vendor/profile", async () => {
    expect(await target()).toBe("/vendor/profile");
  });
  it("settings/payouts carries the resolved tab", async () => {
    const id = resolveVendorSettingsTab("payouts");
    expect(await target(["payouts"])).toBe(id ? `/vendor/profile?tab=${id}` : "/vendor/profile");
  });
  it("?tab=quick-replies carries the resolved tab", async () => {
    const id = resolveVendorSettingsTab("quick-replies");
    expect(id).toBeTruthy();
    expect(await target(undefined, { tab: "quick-replies" })).toBe(`/vendor/profile?tab=${id}`);
  });
  it("unknown tab -> plain profile; extra segments 404", async () => {
    expect(await target(["nope"])).toBe("/vendor/profile");
    await expect(target(["a", "b"])).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
