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
};

describe("composeDirectoryCategories", () => {
  it("hides Manager and Vendor on manager portal until contacts exist", () => {
    expect(composeDirectoryCategories("manager", [])).toEqual(["resident"]);
    expect(composeDirectoryCategories("manager", [resident])).toEqual(["resident"]);
    expect(composeDirectoryCategories("manager", [resident, coManager])).toEqual([
      "resident",
      "management",
    ]);
    expect(composeDirectoryCategories("manager", [resident, coManager, vendor])).toEqual([
      "resident",
      "management",
      "vendor",
    ]);
  });

  it("PRP-150: a manager is not offered PropLane admin as a contact", () => {
    // Writing to us is a support request, not portal correspondence. Sitting in
    // the same picker as their own residents and co-managers made the list read
    // as though PropLane were one of their contacts.
    expect(composeDirectoryCategories("manager", [resident, coManager, vendor])).not.toContain(
      "admin",
    );
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
