import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  composeCategoryForContact,
  roleComposeCapabilities,
  scopedComposeCategories,
  scopedPeopleForCategory,
} from "@/lib/role-compose";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const contacts: InboxScopedContact[] = [
  { id: "mgr-1", userId: "u1", name: "Mina", email: "mina@example.com", role: "manager" },
  { id: "res-1", userId: "u2", name: "Rae", email: "rae@example.com", role: "resident", propertyId: "p1", propertyLabel: "Elm House" },
];

describe("roleComposeCapabilities", () => {
  it("residents never schedule from New message and never Text", () => {
    const caps = roleComposeCapabilities("resident", true);
    expect(caps.schedule).toBe(false);
    expect(caps.channels).toEqual(["proplane", "email"]);
    expect(caps.otherRecipients).toBe(false);
    expect(caps.draft).toBe(false);
  });

  it("vendors cannot Text, schedule or draft (no backing route) but can attach", () => {
    const caps = roleComposeCapabilities("vendor", true);
    expect(caps.channels).toEqual([]);
    expect(caps.schedule).toBe(false);
    expect(caps.draft).toBe(false);
    expect(caps.attach).toBe(true);
  });

  it("managers keep every tool; Text only with the SMS UI", () => {
    expect(roleComposeCapabilities("manager", false).channels).toEqual(["proplane", "email"]);
    const caps = roleComposeCapabilities("manager", true);
    expect(caps.channels).toEqual(["proplane", "email", "sms"]);
    expect(caps).toMatchObject({ schedule: true, attach: true, draft: true, otherRecipients: true });
  });
});

describe("scoped recipients", () => {
  it("a vendor sees Manager + admin sections; a resident adds their household", () => {
    expect(scopedComposeCategories("vendor", contacts)).toEqual(["management", "admin"]);
    expect(scopedComposeCategories("resident", contacts)).toEqual(["resident", "management", "admin"]);
  });

  it("lists people from the handed list only, with no broadcast rows", () => {
    expect(scopedPeopleForCategory("management", "resident", contacts).map((p) => p.key)).toEqual(["id:mgr-1"]);
    expect(scopedPeopleForCategory("resident", "resident", contacts).map((p) => p.key)).toEqual(["id:res-1"]);
  });

  it("files a contact under the section its portal lists", () => {
    expect(composeCategoryForContact("resident", contacts[0]!)).toBe("management");
    expect(composeCategoryForContact("resident", contacts[1]!)).toBe("resident");
    expect(composeCategoryForContact("manager", contacts[1]!)).toBe("house:p1");
  });
});

describe("the older scoped window is gone", () => {
  it("no source mounts ScopedInboxComposeModal", () => {
    for (const file of [
      "vendor-inbox-panel.tsx",
      "resident-inbox-panel.tsx",
      "pro-inbox.tsx",
    ]) {
      const src = readFileSync(`src/components/portal/${file}`, "utf8");
      expect(src).not.toContain("ScopedInboxComposeModal");
      expect(src).toContain("ManagerCommunicationComposeModal");
    }
  });
});
