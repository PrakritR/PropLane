/**
 * Portal simplification (Oct 18): Settings pages were folded together and every
 * old `?tab=` id must still land somewhere real.
 *   - Vendor Settings: fourteen pages down to ten. Quick replies and Work number &
 *     email are sections of Phone & notifications, Account is a section of Login &
 *     security, Feedback lands on Profile.
 *   - Manager Settings: Billing & plan and Balance & payouts are one page
 *     (`payments`, "Billing & payouts"), Account is a section of Login & security.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VENDOR_SETTINGS_RAIL, resolveVendorSettingsTab } from "@/lib/portals/vendor-settings-pages";

const OLD_VENDOR_PAGE_IDS = [
  "profile",
  "security",
  "business",
  "capabilities",
  "ai-info",
  "integrations",
  "payouts",
  "invoicing",
  "messaging",
  "quick-replies",
  "work-number-email",
  "preferences",
  "feedback",
  "account",
] as const;

const railIds = VENDOR_SETTINGS_RAIL.flatMap((g) => g.pages.map((p) => p.id as string));

describe("vendor Settings merged pages", () => {
  it("the rail has exactly ten pages", () => {
    expect(railIds).toHaveLength(10);
    expect(new Set(railIds).size).toBe(10);
  });

  it.each(OLD_VENDOR_PAGE_IDS)("old page id %s still resolves to a rail page", (id) => {
    const resolved = resolveVendorSettingsTab(id);
    expect(resolved, id).not.toBeNull();
    expect(railIds).toContain(resolved);
  });

  it("the folded ids land on the page that now holds them", () => {
    expect(resolveVendorSettingsTab("feedback")).toBe("profile");
    expect(resolveVendorSettingsTab("account")).toBe("security");
    expect(resolveVendorSettingsTab("quick-replies")).toBe("messaging");
    expect(resolveVendorSettingsTab("work-number-email")).toBe("messaging");
  });

  it("the ids that kept their page resolve to themselves", () => {
    for (const id of ["profile", "security", "business", "capabilities", "ai-info", "integrations", "payouts", "invoicing", "messaging", "preferences"]) {
      expect(resolveVendorSettingsTab(id)).toBe(id);
    }
  });
});

describe("manager Settings merged pages", () => {
  const src = readFileSync(join(process.cwd(), "src/components/portal/portal-profile-client.tsx"), "utf8");

  it("maps the billing alias to payments and the account alias to security, for the manager variant only", () => {
    expect(src).toMatch(/variant === "manager" && rawTabParam === "billing"\s*\?\s*"payments"/);
    expect(src).toMatch(/variant === "manager" && rawTabParam === "account"\s*\?\s*"security"/);
  });

  it("maps the payouts alias to payments", () => {
    expect(src).toContain('router.replace("/portal/profile?tab=payments")');
  });

  it("has one Billing & payouts page and no separate Billing & plan, Balance & payouts or manager Account page", () => {
    expect(src).toContain('id: "payments", label: "Billing & payouts"');
    expect(src).not.toContain('label: "Billing & plan"');
    expect(src).not.toContain('label: "Balance & payouts"');
    // Account stays only behind the non-manager (admin) variant.
    expect(src).toMatch(/if \(variant !== "manager"\) \{\s*list\.push\(\{\s*id: "account"/);
  });

  it("Login & security carries the Account section for the manager variant", () => {
    expect(src).toMatch(/case "security":[\s\S]*variant === "manager" \? <PortalSettingsExtras/);
  });
});
