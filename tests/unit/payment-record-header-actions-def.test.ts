import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";

/** C2-PAY1: payment record actions are icon-only in the header (registry defaults). */
describe("manager/payment header actions", () => {
  it("are mark-paid offline, send-reminder, delete (no Download CSV, no settings gear)", () => {
    const sections = recordSections("manager", "payment", { basePath: "/portal" });
    expect(sections.headerActions.map((action) => action.id)).toEqual([
      "mark-paid",
      "send-reminder",
      "delete",
    ]);
  });
});
