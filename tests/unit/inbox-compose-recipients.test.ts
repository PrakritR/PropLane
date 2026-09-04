import { describe, expect, it } from "vitest";
import {
  composeDirectoryCategories,
  composeValidPersonKeys,
  isAdminOnlyDirectorySelection,
  mergeAdminComposePersonKey,
} from "@/lib/inbox-compose-recipients";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const coManager: InboxScopedContact = {
  id: "rel-1",
  name: "Alex Co",
  email: "alex@example.com",
  role: "manager",
};

const vendor: InboxScopedContact = {
  id: "ven-1",
  name: "Plumber Pro",
  email: "vendor@example.com",
  role: "vendor",
};

const resident: InboxScopedContact = {
  id: "res-1",
  name: "Sam Resident",
  email: "sam@example.com",
  role: "resident",
  propertyId: "prop-1",
  propertyLabel: "Brooklyn House",
};

describe("composeDirectoryCategories", () => {
  it("groups manager portal recipients by house, then role sections", () => {
    expect(composeDirectoryCategories("manager", [])).toEqual(["management", "vendor", "admin"]);
    expect(composeDirectoryCategories("manager", [resident])).toEqual([
      "house:prop-1",
      "management",
      "vendor",
      "admin",
    ]);
    expect(composeDirectoryCategories("manager", [resident, coManager])).toEqual([
      "house:prop-1",
      "management",
      "vendor",
      "admin",
    ]);
    expect(composeDirectoryCategories("manager", [resident, coManager, vendor])).toEqual([
      "house:prop-1",
      "management",
      "vendor",
      "admin",
    ]);
  });

  it("offers PropLane admin to managers alongside house and role groups", () => {
    expect(composeDirectoryCategories("manager", [resident, coManager, vendor])).toContain("admin");
  });

  it("…but residents and vendors keep it — it is their only way out", () => {
    expect(composeDirectoryCategories("resident", [])).toContain("admin");
    expect(composeDirectoryCategories("vendor", [])).toContain("admin");
  });

  it("keeps resident portal management for property managers", () => {
    expect(composeDirectoryCategories("resident", [coManager])).toEqual([
      "resident",
      "management",
      "admin",
    ]);
  });
});

describe("admin compose auto-select", () => {
  it("detects admin-only selection", () => {
    expect(isAdminOnlyDirectorySelection(["admin"])).toBe(true);
    expect(isAdminOnlyDirectorySelection(["admin", "resident"])).toBe(false);
  });

  it("adds and removes admin person key with the To section", () => {
    expect(mergeAdminComposePersonKey(["admin"], [])).toEqual(["admin"]);
    expect(mergeAdminComposePersonKey(["resident"], ["admin"])).toEqual([]);
    expect(mergeAdminComposePersonKey(["admin", "resident"], ["broadcast:resident"])).toEqual([
      "broadcast:resident",
      "admin",
    ]);
  });

  it("keeps the synthetic admin key in valid person keys", () => {
    const keys = composeValidPersonKeys(["broadcast:resident"], ["admin", "resident"]);
    expect(keys.has("admin")).toBe(true);
    expect(keys.has("broadcast:resident")).toBe(true);
    expect(composeValidPersonKeys([], ["resident"]).has("admin")).toBe(false);
  });
});
