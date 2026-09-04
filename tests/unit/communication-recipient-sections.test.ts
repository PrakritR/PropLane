/**
 * PRP-150 — the manager's To picker.
 *
 * "list out all residents by name not by phone number or email … have separate
 * sections for messages (potential resident, current resident, past resident) …
 * remove proplane admin from manager"
 */
import { describe, expect, it } from "vitest";
import { composeDirectoryCategories } from "@/lib/inbox-compose-recipients";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const person = (over: Partial<InboxScopedContact>): InboxScopedContact =>
  ({ id: "x", name: "X", email: "x@example.com", role: "resident", ...over }) as InboxScopedContact;

const applicant = person({ id: "a1", name: "Ada Applicant", tenancyStatus: "applicant" });
const current = person({ id: "r1", name: "Rae Resident", tenancyStatus: "resident" });
const past = person({ id: "p1", name: "Pat Past", tenancyStatus: "past" });
const coManager = person({ id: "m1", name: "Mo Manager", role: "manager" });
const vendor = person({ id: "v1", name: "Vic Vendor", role: "vendor" });

describe("the three resident sections", () => {
  it("splits potential, current and past", () => {
    expect(composeDirectoryCategories("manager", [applicant, current, past])).toEqual([
      "applicant",
      "resident",
      "past_resident",
    ]);
  });

  it("only shows a bucket that has someone in it", () => {
    // A manager with no applicants should not be offered an empty section.
    expect(composeDirectoryCategories("manager", [current])).toEqual(["resident"]);
    expect(composeDirectoryCategories("manager", [applicant, current])).toEqual([
      "applicant",
      "resident",
    ]);
  });

  it("always keeps Current residents, even with none yet", () => {
    // It is the section every other bucket is defined against; a brand new
    // manager still needs somewhere to write.
    expect(composeDirectoryCategories("manager", [])).toEqual(["resident"]);
  });

  it("treats a resident with no recorded status as current", () => {
    expect(composeDirectoryCategories("manager", [person({ id: "u1", name: "Unknown" })])).toEqual([
      "resident",
    ]);
  });

  it("still offers co-managers and vendors when they exist", () => {
    expect(composeDirectoryCategories("manager", [current, coManager, vendor])).toEqual([
      "resident",
      "management",
      "vendor",
    ]);
  });

  it("never offers a manager PropLane admin", () => {
    expect(composeDirectoryCategories("manager", [current, coManager, vendor])).not.toContain("admin");
  });
});

describe("what a recipient row says", () => {
  const modal = new URL("../../src/components/portal/manager-communication-compose-modal.tsx", import.meta.url);
  const src = require("node:fs").readFileSync(modal, "utf8") as string;

  it("shows the name and the house, not an address", () => {
    expect(src).toContain('return [name, property].filter(Boolean).join(" · ");');
  });

  it("falls back to the address only when there is no name at all", () => {
    // A blank row is worse than an address.
    expect(src).toContain("if (!name) return contact.email;");
  });

  it("labels the sections in the captain's words", () => {
    expect(src).toContain('return "Potential residents"');
    expect(src).toContain('return "Current residents"');
    expect(src).toContain('return "Past residents"');
  });

  it("scopes the broadcast row to CURRENT residents", () => {
    // "All residents" that also reached applicants and people who moved out is
    // the thing the split exists to prevent.
    expect(src).toContain('label: "All current residents"');
  });
});
