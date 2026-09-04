/**
 * PRP-150 — the manager's To picker.
 *
 * "list out all residents by name not by phone number or email … have separate
 * sections for messages (potential resident, current resident, past resident) …
 * remove proplane admin from manager"
 *
 * Updated: manager picker groups by house, with Manager / Vendor / Admin sections.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  composeDirectoryCategories,
  houseComposeCategoryLabel,
  residentHousesFromContacts,
} from "@/lib/inbox-compose-recipients";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const person = (over: Partial<InboxScopedContact>): InboxScopedContact =>
  ({ id: "x", name: "X", email: "x@example.com", role: "resident", ...over }) as InboxScopedContact;

const applicant = person({
  id: "a1",
  name: "Ada Applicant",
  tenancyStatus: "applicant",
  propertyId: "p1",
  propertyLabel: "Brooklyn House",
});
const current = person({
  id: "r1",
  name: "Rae Resident",
  tenancyStatus: "resident",
  propertyId: "p1",
  propertyLabel: "Brooklyn House",
});
const past = person({
  id: "p1",
  name: "Pat Past",
  tenancyStatus: "past",
  propertyId: "p2",
  propertyLabel: "Ballard House",
});
const coManager = person({ id: "m1", name: "Mo Manager", role: "manager" });
const vendor = person({ id: "v1", name: "Vic Vendor", role: "vendor" });

describe("manager compose sections group by house", () => {
  it("lists one section per house, then Manager, Vendor, and PropLane admin", () => {
    // Houses are ordered by NAME, not by id — `residentHousesFromContacts`
    // sorts on the label so a manager scanning a portfolio finds a house where
    // they expect it alphabetically. The fixtures make that visible on purpose:
    // p2 is "Ballard House" and p1 is "Brooklyn House", so p2 comes first.
    expect(composeDirectoryCategories("manager", [applicant, current, past, coManager, vendor])).toEqual([
      "house:p2",
      "house:p1",
      "management",
      "vendor",
      "admin",
    ]);
  });

  it("sorts houses by label", () => {
    expect(residentHousesFromContacts([current, past]).map((h) => h.label)).toEqual([
      "Ballard House",
      "Brooklyn House",
    ]);
  });

  it("labels a house section from the property name", () => {
    expect(houseComposeCategoryLabel("house:p1", [current])).toBe("Brooklyn House");
  });

  it("always offers Manager, Vendor, and PropLane admin even with an empty directory", () => {
    expect(composeDirectoryCategories("manager", [])).toEqual(["management", "vendor", "admin"]);
  });

  it("adds an unassigned bucket when a resident has no house", () => {
    expect(composeDirectoryCategories("manager", [person({ id: "u1", name: "Unknown" })])).toEqual([
      "unassigned_residents",
      "management",
      "vendor",
      "admin",
    ]);
  });
});

describe("what a recipient row says", () => {
  const modal = new URL("../../src/components/portal/pro-communication-compose-modal.tsx", import.meta.url);
  const src = readFileSync(modal, "utf8");

  it("shows the name and the house, not an address", () => {
    expect(src).toContain('return [name, property].filter(Boolean).join(" · ");');
  });

  it("falls back to the address only when there is no name at all", () => {
    expect(src).toContain("if (!name) return contact.email;");
  });

  it("labels role groups in the captain's words", () => {
    expect(src).toContain('return "Manager"');
    expect(src).toContain('return "Vendor"');
    expect(src).toContain('return "PropLane admin"');
  });

  it("scopes the house broadcast row to CURRENT residents of that house", () => {
    expect(src).toContain("houseBroadcastOptions(currentResidents)");
  });
});
