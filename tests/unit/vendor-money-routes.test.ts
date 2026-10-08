import { describe, expect, it, vi } from "vitest";
import { vendorPortal, VENDOR_PORTAL_SMOKE_PATHS } from "@/lib/portals/vendor";
import { PORTAL_NAV_GROUPS } from "@/lib/portals/nav-groups";
import { NATIVE_BOTTOM_NAV_VENDOR_ORDER } from "@/lib/native/portal-bottom-nav";
import {
  vendorDocumentsHref,
  vendorIncomingHref,
  vendorMovedMoneyPath,
  vendorOutgoingHref,
} from "@/lib/vendor-money-routes";

/**
 * Vendor Money group (vendor-portal-ia-1007): Incoming payments · Outgoing payments · Finances ·
 * Documents, each its own sidebar row, and every old URL still landing on its new home.
 */
class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
  notFound: () => {
    throw new NotFoundError();
  },
}));

const { renderPortalSection } = await import("@/lib/render-portal-section/vendor");

async function landing(section: string, tabs?: string[], search?: Record<string, string>): Promise<string | "renders"> {
  try {
    await renderPortalSection("vendor", section, tabs, search);
    return "renders";
  } catch (error) {
    if (error instanceof RedirectError) return error.to;
    throw error;
  }
}

describe("vendor Money group registry", () => {
  it("lists Incoming payments, Outgoing payments, Finances and Documents, each its own row", () => {
    const money = PORTAL_NAV_GROUPS.vendor.find((group) => group.id === "money")!;
    expect(money.sections).toEqual(["payments", "outgoing", "financials", "documents"]);
    const label = (section: string) => vendorPortal.sections.find((s) => s.section === section)?.label;
    expect(money.sections.map(label)).toEqual(["Incoming payments", "Outgoing payments", "Finances", "Documents"]);
  });

  it("Finances is Overview · Balance & payouts · Refunds; Documents has the five tabs", () => {
    const tabs = (section: string) => vendorPortal.sections.find((s) => s.section === section)!.tabs.map((t) => t.label);
    expect(tabs("financials")).toEqual(["Overview", "Balance & payouts", "Refunds"]);
    expect(tabs("documents")).toEqual(["Tax", "Business license", "Insurance", "Statements", "From managers"]);
  });

  it("the native bottom nav order carries the same sections (derived from the registry)", () => {
    const registry = vendorPortal.sections.map((s) => s.section);
    for (const section of NATIVE_BOTTOM_NAV_VENDOR_ORDER) expect(registry).toContain(section);
    expect(NATIVE_BOTTOM_NAV_VENDOR_ORDER).toEqual(
      expect.arrayContaining(["payments", "outgoing", "financials", "documents"]),
    );
  });

  it("every Money smoke path resolves to a rendered page", async () => {
    const money = VENDOR_PORTAL_SMOKE_PATHS.filter((p) =>
      /\/vendor\/(payments|outgoing|financials|documents)\//.test(p.path),
    );
    expect(money.length).toBeGreaterThanOrEqual(5);
    for (const { path } of money) {
      const [, , section, ...tabs] = path.split("/");
      expect(await landing(section!, tabs)).toBe("renders");
    }
  });
});

describe("moved URLs land on their new home", () => {
  it.each([
    ["financials", ["income"], "/vendor/payments/pending"],
    ["financials", ["income", "pending"], "/vendor/payments/pending"],
    ["financials", ["statements"], "/vendor/documents/statements"],
    ["financials", ["tax"], "/vendor/documents/tax"],
    ["financials", ["invoices"], "/vendor/payments/pending"],
    ["financials", undefined, "/vendor/financials/overview"],
    ["financials", ["payouts"], "/vendor/financials/balance"],
    ["payments", undefined, "/vendor/payments/pending"],
    ["payments", ["incoming", "paid"], "/vendor/payments/paid"],
    ["payments", ["outgoing"], "/vendor/outgoing/this-month"],
    ["payments", ["outgoing", "earlier"], "/vendor/outgoing/earlier"],
    ["outgoing", undefined, "/vendor/outgoing/this-month"],
    ["documents", undefined, "/vendor/documents/tax"],
    ["documents", ["licensing"], "/vendor/documents/license"],
    ["documents", ["nonsense"], "/vendor/documents/tax"],
  ] as const)("/vendor/%s/%j -> %s", async (section, tabs, to) => {
    expect(await landing(section, tabs ? [...tabs] : undefined)).toBe(to);
  });

  it("/vendor/profile?tab=licenses and /vendor/settings/licenses land on Documents > Business license", async () => {
    expect(await landing("profile", undefined, { tab: "licenses" })).toBe("/vendor/documents/license");
    expect(await landing("settings", ["licenses"])).toBe("/vendor/documents/license");
    expect(await landing("settings", undefined, { tab: "licenses" })).toBe("/vendor/documents/license");
  });

  it("the Settings rail no longer lists Licenses & insurance", async () => {
    const { VENDOR_SETTINGS_RAIL, resolveVendorSettingsTab } = await import("@/lib/portals/vendor-settings-pages");
    const labels = VENDOR_SETTINGS_RAIL.flatMap((group) => group.pages.map((page) => page.label));
    expect(labels).not.toContain("Licenses & insurance");
    expect(resolveVendorSettingsTab("licenses")).toBeNull();
  });

  it("renders the real pages for every new segment and tab", async () => {
    for (const tabs of [["pending"], ["paid"], ["overdue"]]) expect(await landing("payments", tabs)).toBe("renders");
    for (const tabs of [["this-month"], ["last-month"], ["earlier"]]) expect(await landing("outgoing", tabs)).toBe("renders");
    for (const tab of ["overview", "balance", "refunds"]) expect(await landing("financials", [tab])).toBe("renders");
    for (const tab of ["tax", "license", "insurance", "statements", "from-managers"]) {
      expect(await landing("documents", [tab])).toBe("renders");
    }
  });

  it("still 404s an unknown segment or a nested path", async () => {
    await expect(landing("payments", ["bogus"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(landing("payments", ["paid", "x"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(landing("outgoing", ["tomorrow"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(landing("financials", ["bogus"])).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("an invoice's and a payment's own record pages still render", async () => {
    expect(await landing("financials", ["invoices", "inv-1"])).toBe("renders");
    expect(await landing("financials", ["payouts", "po-1"])).toBe("renders");
  });
});

describe("vendorMovedMoneyPath (pure)", () => {
  it("ignores URLs that did not move", () => {
    expect(vendorMovedMoneyPath("/vendor", "financials", ["balance"])).toBeNull();
    expect(vendorMovedMoneyPath("/vendor", "financials", ["invoices", "inv-1"])).toBeNull();
    expect(vendorMovedMoneyPath("/vendor", "profile", undefined, "payouts")).toBeNull();
    expect(vendorMovedMoneyPath("/vendor", "work-orders", ["open"])).toBeNull();
  });

  it("builds hrefs on the given base path", () => {
    expect(vendorIncomingHref("/vendor", "overdue")).toBe("/vendor/payments/overdue");
    expect(vendorOutgoingHref("/vendor")).toBe("/vendor/outgoing/this-month");
    expect(vendorDocumentsHref("/vendor", "from-managers")).toBe("/vendor/documents/from-managers");
  });
});
