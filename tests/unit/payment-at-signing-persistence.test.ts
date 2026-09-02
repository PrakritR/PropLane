/**
 * "I check Move-in fee and that info does not save."
 *
 * Whether the deposit / move-in fee is due at signing lives in TWO places: the
 * Payment-at-signing checkbox list, and `dueAtSigning` on the fee row that the
 * Pricing table also toggles. The row is derived from the list
 * (`listingFeeRowsFromSubmission`) and the list is derived back from the row
 * (`derivePaymentAtSigningIncludes`). Ticking the checkbox used to write only
 * the list, leaving a materialized row that said the opposite — and the next
 * pass through the fee pipeline recomputed the list from that stale row and
 * dropped the tick. The checkbox saved, then something overwrote it.
 */
import { describe, expect, it } from "vitest";
import {
  applyListingFeesToSubmission,
  applyPaymentAtSigningSelection,
  derivePaymentAtSigningIncludes,
  listingFeesFromLegacyScalars,
} from "@/lib/listing-fees";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

type Sub = Pick<ManagerListingSubmissionV1, "paymentAtSigningIncludes" | "customFees">;

function subWithRows(dueMoveIn: boolean): Sub {
  return {
    paymentAtSigningIncludes: dueMoveIn ? ["security_deposit", "move_in_fee"] : ["security_deposit"],
    customFees: [
      { id: "fee-security_deposit", label: "Security deposit", amount: "400", frequency: "one_time", presetId: "security_deposit", dueAtSigning: true },
      { id: "fee-move_in_fee", label: "Move-in fee", amount: "150", frequency: "one_time", presetId: "move_in_fee", dueAtSigning: dueMoveIn },
    ],
  } as Sub;
}

describe("payment at signing persists", () => {
  it("ticking Move-in fee updates the fee row too, so the pipeline cannot undo it", () => {
    const next = applyPaymentAtSigningSelection(subWithRows(false), "move_in_fee", true);
    expect(next.paymentAtSigningIncludes).toContain("move_in_fee");
    const row = (next.customFees ?? []).find((f) => (f as { presetId?: string }).presetId === "move_in_fee");
    expect(row?.dueAtSigning).toBe(true);

    // The regression: recompute the list from the rows, as a later fee edit does.
    expect(derivePaymentAtSigningIncludes(next.paymentAtSigningIncludes, next.customFees ?? [])).toContain(
      "move_in_fee",
    );
  });

  it("survives a full round trip through the fee pipeline", () => {
    const next = applyPaymentAtSigningSelection(subWithRows(false), "move_in_fee", true) as ManagerListingSubmissionV1;
    const applied = applyListingFeesToSubmission(next, next.customFees ?? []);
    expect(applied.paymentAtSigningIncludes).toContain("move_in_fee");
  });

  it("unticking clears both sides and stays cleared", () => {
    const next = applyPaymentAtSigningSelection(subWithRows(true), "move_in_fee", false);
    expect(next.paymentAtSigningIncludes).not.toContain("move_in_fee");
    const row = (next.customFees ?? []).find((f) => (f as { presetId?: string }).presetId === "move_in_fee");
    expect(row?.dueAtSigning).toBe(false);
    expect(derivePaymentAtSigningIncludes(next.paymentAtSigningIncludes, next.customFees ?? [])).not.toContain(
      "move_in_fee",
    );
  });

  it("keeps the checkbox order stable rather than click order", () => {
    let sub = applyPaymentAtSigningSelection(subWithRows(false), "first_month_rent", true);
    sub = applyPaymentAtSigningSelection(sub, "move_in_fee", true);
    expect(sub.paymentAtSigningIncludes).toEqual([
      "security_deposit",
      "move_in_fee",
      "first_month_rent",
    ]);
  });

  it("needs no fee row to exist yet — the row is derived from the list", () => {
    const fresh: Sub = { paymentAtSigningIncludes: ["security_deposit"], customFees: [] };
    const next = applyPaymentAtSigningSelection(fresh, "move_in_fee", true) as ManagerListingSubmissionV1;
    expect(next.paymentAtSigningIncludes).toContain("move_in_fee");
    const rows = listingFeesFromLegacyScalars({ ...next, moveInFee: "150", securityDeposit: "400" } as never);
    expect(rows.find((r) => r.presetId === "move_in_fee")?.dueAtSigning).toBe(true);
  });
});
