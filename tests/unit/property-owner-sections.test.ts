/**
 * The owner-only account's section allow-list: five rows (Overview, Properties, Money, Messages only while on, Settings),
 * with Statements, Finances and Documents as Money's tabs. Everything else is sent to Overview, whether it came from the
 * menu, a bookmark or the address bar.
 */
import { describe, expect, it } from "vitest";

import {
  OWNER_HOME_PATH,
  ownerMoneyTabForPath,
  ownerMoneyTabs,
  ownerNavItems,
  ownerPathAllowed,
  ownerPrimaryNavItems,
  ownerRedirectFor,
  ownerSectionForPath,
} from "@/lib/property-owner/sections";

describe("owner nav", () => {
  it("is at most five rows: Overview, Properties, Money, Settings, and Messages only when on", () => {
    expect(ownerNavItems(false).map((i) => i.label)).toEqual(["Overview", "Properties", "Money", "Settings"]);
    expect(ownerNavItems(true).map((i) => i.label)).toEqual(["Overview", "Properties", "Money", "Messages", "Settings"]);
    expect(ownerNavItems(true).length).toBeLessThanOrEqual(5);
  });

  it("keeps Settings off the phone bottom bar (it lives in More)", () => {
    expect(ownerPrimaryNavItems(true).map((i) => i.id)).toEqual(["overview", "properties", "money", "messages"]);
  });

  it("only links to owner routes", () => {
    for (const item of ownerNavItems(true)) expect(item.href.startsWith("/portal/owner")).toBe(true);
  });

  it("folds Statements, Finances and Documents into Money's tabs, Finances only when held", () => {
    expect(ownerMoneyTabs(false).map((t) => t.label)).toEqual(["Statements", "Documents"]);
    expect(ownerMoneyTabs(true).map((t) => t.label)).toEqual(["Statements", "Finances", "Documents"]);
    expect(ownerNavItems(false).find((i) => i.id === "money")?.href).toBe("/portal/owner/statements");
  });

  it("maps every owner path to the one row that owns it", () => {
    expect(ownerSectionForPath("/portal/owner")).toBe("overview");
    expect(ownerSectionForPath("/portal/owner/properties/abc")).toBe("properties");
    for (const path of ["/portal/owner/statements", "/portal/owner/statements/2026-10", "/portal/owner/finances", "/portal/owner/documents"]) {
      expect(ownerSectionForPath(path), path).toBe("money");
    }
    expect(ownerSectionForPath("/portal/owner/messages")).toBe("messages");
    expect(ownerSectionForPath("/portal/owner/profile")).toBe("settings");
    expect(ownerSectionForPath("/portal/dashboard")).toBeNull();
    expect(ownerMoneyTabForPath("/portal/owner/finances")).toBe("finances");
    expect(ownerMoneyTabForPath("/portal/owner/properties")).toBeNull();
  });
});

describe("ownerPathAllowed", () => {
  it("allows the owner pages", () => {
    for (const path of [
      "/portal/owner",
      "/portal/owner/",
      "/portal/owner/properties",
      "/portal/owner/properties/abc-123",
      "/portal/owner/statements",
      "/portal/owner/statements/2026-10",
      "/portal/owner/documents",
      "/portal/owner/profile",
    ]) {
      expect(ownerPathAllowed(path, false), path).toBe(true);
    }
  });

  it("allows Messages only while it is on", () => {
    expect(ownerPathAllowed("/portal/owner/messages", false)).toBe(false);
    expect(ownerPathAllowed("/portal/owner/messages", true)).toBe(true);
  });

  it("refuses every manager section, a lookalike prefix and an unknown owner child", () => {
    for (const path of [
      "/portal",
      "/portal/dashboard",
      "/portal/residents",
      "/portal/vendors",
      "/portal/properties",
      "/portal/documents/library",
      "/portal/communication/active",
      "/portal/profile",
      "/portal/owner-evil",
      "/portal/owner/teams",
      "/portal/ownerx/properties",
      "/resident",
    ]) {
      expect(ownerPathAllowed(path, true), path).toBe(false);
    }
  });

  it("redirects a refused path to Overview and leaves an allowed one alone", () => {
    expect(ownerRedirectFor("/portal/residents", false)).toBe(OWNER_HOME_PATH);
    expect(ownerRedirectFor("/api/reports/rent-roll", false)).toBe(OWNER_HOME_PATH);
    expect(ownerRedirectFor("/portal/owner/statements", false)).toBeNull();
  });
});

describe("owner Finances section", () => {
  it("is a Money tab for the owner of record of a managed workspace, never a row of its own", () => {
    expect(ownerNavItems(false).map((i) => i.id)).not.toContain("finances");
    expect(ownerMoneyTabs(false).map((t) => t.id)).not.toContain("finances");
    expect(ownerMoneyTabs(true).find((t) => t.id === "finances")?.href).toBe("/portal/owner/finances");
  });

  it("opens the Finances page only while it is on, and sends everyone else to Overview", () => {
    expect(ownerPathAllowed("/portal/owner/finances", false)).toBe(false);
    expect(ownerPathAllowed("/portal/owner/finances", false, true)).toBe(true);
    expect(ownerPathAllowed("/portal/owner/finances/", true, true)).toBe(true);
    expect(ownerRedirectFor("/portal/owner/finances", true)).toBe(OWNER_HOME_PATH);
    expect(ownerRedirectFor("/portal/owner/finances", true, true)).toBeNull();
  });
});
