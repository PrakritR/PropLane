/**
 * The owner-only account's section allow-list: Overview, Properties, Statements,
 * Documents (+ Messages only while on) and Profile. Everything else is sent to
 * Overview, whether it came from the menu, a bookmark or the address bar.
 */
import { describe, expect, it } from "vitest";

import {
  OWNER_HOME_PATH,
  ownerNavItems,
  ownerPathAllowed,
  ownerPrimaryNavItems,
  ownerRedirectFor,
} from "@/lib/property-owner/sections";

describe("owner nav", () => {
  it("is Overview, Properties, Statements, Documents and Profile, and Messages only when on", () => {
    expect(ownerNavItems(false).map((i) => i.label)).toEqual(["Overview", "Properties", "Statements", "Documents", "Profile"]);
    expect(ownerNavItems(true).map((i) => i.label)).toEqual(["Overview", "Properties", "Statements", "Documents", "Messages", "Profile"]);
  });

  it("keeps Profile off the phone bottom bar (it lives in More)", () => {
    expect(ownerPrimaryNavItems(true).map((i) => i.id)).toEqual(["overview", "properties", "statements", "documents", "messages"]);
  });

  it("only links to owner routes", () => {
    for (const item of ownerNavItems(true)) expect(item.href.startsWith("/portal/owner")).toBe(true);
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
