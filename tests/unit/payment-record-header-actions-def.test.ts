import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";

/**
 * PLAN-0920-2357 stream C: the payment record header carried a dead "Edit"
 * action — there is nothing on a payment record for it to open, and the
 * record itself lives entirely through its actual header actions (record
 * payment, send reminder, delete). This pins the exact remaining set so a
 * future add can't silently reintroduce a dead action without touching this
 * test.
 */
describe("manager/payment header actions", () => {
  it("are exactly record-payment, send-reminder, delete", () => {
    const sections = recordSections("manager", "payment", { basePath: "/portal" });
    expect(sections.headerActions.map((action) => action.id)).toEqual([
      "record-payment",
      "send-reminder",
      "delete",
    ]);
  });
});
