import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";

/** C2-PAY1: payment record actions are icon-only in the header (registry defaults). */
describe("manager/payment header actions", () => {
  it("are take-payment, mark-paid offline, send-reminder, download, delete", () => {
    const sections = recordSections("manager", "payment", { basePath: "/portal" });
    expect(sections.headerActions.map((action) => action.id)).toEqual([
      "take-payment",
      "mark-paid",
      "send-reminder",
      "download",
      "delete",
    ]);
  });
});
