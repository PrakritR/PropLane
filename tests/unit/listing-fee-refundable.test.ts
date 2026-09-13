import { describe, expect, it } from "vitest";
import { buildListingQuote } from "@/lib/listing-quote";
import { normalizeListingFeeRow, presetListingFeeRow } from "@/lib/listing-fees";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";

function subWithFees(fees: ReturnType<typeof normalizeListingFeeRow>[]): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const withDeposit = { ...base, securityDeposit: "1000", entireHomeMonthlyRent: 1000 };
  return applyListingFeesToSubmission(normalizeManagerListingSubmissionV1(withDeposit), fees);
}

describe("listing fee refundable options", () => {
  it("marks custom one-time fees refundable on the signing receipt", () => {
    const pet = normalizeListingFeeRow({
      id: "fee-pet",
      label: "Pet deposit",
      amount: "200",
      frequency: "one-time",
      presetId: "custom",
      refundable: true,
    });
    const quote = buildListingQuote(subWithFees([pet]), {
      leaseTerm: "12 months",
      roomId: null,
    });
    const petLine = quote.signingLines.find((l) => l.label === "Pet deposit");
    expect(petLine?.note).toBe("Refundable");
  });

  it("reduces security deposit when a one-time fee credits toward it", () => {
    const credit = normalizeListingFeeRow({
      id: "fee-credit",
      label: "Pet deposit",
      amount: "300",
      frequency: "one-time",
      presetId: "custom",
      creditsTowardSecurity: true,
      refundable: true,
    });
    const sec = presetListingFeeRow("security_deposit", "1000");
    const quote = buildListingQuote(subWithFees([sec, credit]), {
      leaseTerm: "12 months",
      roomId: null,
    });
    expect(quote.securityDeposit).toBe(700);
    const secLine = quote.signingLines.find((l) => l.key === "security_deposit");
    expect(secLine?.amount).toBe(700);
  });
});
