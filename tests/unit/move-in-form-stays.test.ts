/**
 * Move-in forms under the Long-term forms / Short-term forms tabs: a form's stay is its "Applies to", a form for
 * both shows in both tabs, the Short-term tab only exists when the property allows it (or holds a form for it), and
 * Quick add / the round + create for the open tab.
 */
import { describe, expect, it } from "vitest";
import { missingMoveInStarters, submissionWithMoveInStarter } from "@/lib/leasing-quick-add";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  moveInFormAppliesTo,
  moveInFormForStay,
  moveInFormLeaseTypeForStay,
  moveInFormStayTabs,
  moveInFormStays,
  moveInFormsInStay,
} from "@/lib/move-in-forms/stays";
import { newMoveInFormTemplate, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";
import type { MoveInFormTemplate } from "@/lib/move-in-forms/types";

const form = (patch: Partial<MoveInFormTemplate> = {}): MoveInFormTemplate => ({ ...newMoveInFormTemplate("built"), ...patch });
const longOnly = { allowedLeaseTerms: ["Long-term"], shortTermRentalsAllowed: false, airbnbRentalsAllowed: false };
const both = { allowedLeaseTerms: ["Long-term", "Short-Term Stay"], shortTermRentalsAllowed: true, airbnbRentalsAllowed: false };
const leases = [
  { id: "L1", kind: "long-term" },
  { id: "L2", kind: "short-term" },
  { id: "L3", kind: "custom-term" },
];

describe("a move-in form's stay is its Applies to", () => {
  it("All (or no lease type) shows in both stays as the same record", () => {
    expect(moveInFormStays(form({ leaseType: "all" }))).toEqual(["long_term", "short_term"]);
    expect(moveInFormStays(form({ leaseType: undefined }))).toEqual(["long_term", "short_term"]);
    expect(moveInFormAppliesTo(form({ leaseType: "all" }))).toBe("both");
  });

  it("Long-term residents shows only in Long-term forms, Short-term residents only in Short-term forms", () => {
    expect(moveInFormStays(form({ leaseType: "long-term" }))).toEqual(["long_term"]);
    expect(moveInFormStays(form({ leaseType: "short-term" }))).toEqual(["short_term"]);
    const rows = [form({ id: "a", leaseType: "all" }), form({ id: "b", leaseType: "long-term" }), form({ id: "c", leaseType: "short-term" })];
    expect(moveInFormsInStay(rows, "long_term").map((row) => row.id)).toEqual(["a", "b"]);
    expect(moveInFormsInStay(rows, "short_term").map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("a form linked to specific leases takes the stay they share, else both", () => {
    expect(moveInFormStays(form({ linkedLeaseTemplateIds: ["L1"] }), leases)).toEqual(["long_term"]);
    expect(moveInFormStays(form({ linkedLeaseTemplateIds: ["L2"] }), leases)).toEqual(["short_term"]);
    expect(moveInFormStays(form({ linkedLeaseTemplateIds: ["L1", "L3"] }), leases)).toEqual(["long_term"]);
    expect(moveInFormStays(form({ linkedLeaseTemplateIds: ["L1", "L2"] }), leases)).toEqual(["long_term", "short_term"]);
    // A lease that no longer exists is never guessed into one stay.
    expect(moveInFormStays(form({ linkedLeaseTemplateIds: ["gone"] }), leases)).toEqual(["long_term", "short_term"]);
  });
});

describe("the Short-term forms tab", () => {
  const tabs = (sub: typeof both, templates: MoveInFormTemplate[]) => moveInFormStayTabs(sub, templates, leases).tabs;

  it("is absent on a long-term-only property, even with a form for both stays", () => {
    expect(tabs(longOnly, [form({ leaseType: "all" }), form({ leaseType: "long-term" })])).toEqual(["long_term"]);
  });

  it("is kept on a long-term-only property that still holds a short-term-only form", () => {
    expect(tabs(longOnly, [form({ leaseType: "short-term" })])).toEqual(["long_term", "short_term"]);
    expect(tabs(longOnly, [form({ linkedLeaseTemplateIds: ["L2"] })])).toEqual(["long_term", "short_term"]);
  });

  it("is there when the property allows short stays, counting a both-stay form in each tab", () => {
    const templates = [form({ leaseType: "all" }), form({ leaseType: "short-term" })];
    expect(tabs(both, templates)).toEqual(["long_term", "short_term"]);
    expect(moveInFormStayTabs(both, templates, leases).counts).toEqual({ long_term: 1, short_term: 2 });
  });
});

describe("the open tab is where a new form goes", () => {
  it("passes the open stay as the form's lease type", () => {
    expect(moveInFormLeaseTypeForStay("long_term")).toBe("long-term");
    expect(moveInFormLeaseTypeForStay("short_term")).toBe("short-term");
    expect(moveInFormForStay(form({ leaseType: "all" }), "short_term").leaseType).toBe("short-term");
    // A form already tied to specific leases keeps them.
    const linked = form({ linkedLeaseTemplateIds: ["L1"] });
    expect(moveInFormForStay(linked, "short_term")).toBe(linked);
  });

  it("Quick add creates the starter for the open tab and only offers what that tab lacks", () => {
    const sub = createDefaultListingSubmission();
    const added = submissionWithMoveInStarter(sub, "key-receipt", "short_term");
    const [created] = readMoveInFormTemplates(added);
    expect(created!.starterKey).toBe("key-receipt");
    expect(created!.leaseType).toBe("short-term");
    expect(created!.trigger).toBe("manual");
    // The Short-term tab now carries it; the Long-term tab still offers it.
    expect(missingMoveInStarters(added, "short_term").map((entry) => entry.key)).not.toContain("key-receipt");
    expect(missingMoveInStarters(added, "long_term").map((entry) => entry.key)).toContain("key-receipt");
    // Adding it to the Long-term tab too makes a second form for that stay; adding it again there is a no-op.
    const both2 = submissionWithMoveInStarter(added, "key-receipt", "long_term");
    expect(readMoveInFormTemplates(both2)).toHaveLength(2);
    expect(submissionWithMoveInStarter(both2, "key-receipt", "long_term")).toBe(both2);
  });

  it("without a stay Quick add behaves as before (wizard)", () => {
    const added = submissionWithMoveInStarter(createDefaultListingSubmission(), "key-receipt");
    expect(readMoveInFormTemplates(added)[0]!.leaseType ?? "all").toBe("all");
  });
});
