// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { PricingReceiptPanel } from "@/components/portal/listing-wizard-v2/listing-side-panel";
import { buildListingQuote, splitQuoteLinesBySigning } from "@/lib/listing-quote";
import { chargeKindDueAtSigning } from "@/lib/lease-at-signing";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

function stayListing(signing: string[]): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const normalized = normalizeManagerListingSubmissionV1({
    ...base,
    address: "10 Test St",
    city: "Portland",
    state: "OR",
    zip: "97201",
    securityDeposit: "500",
    allowedLeaseTerms: [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM],
    shortTermRentalsAllowed: true,
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Unit 2A", monthlyRent: 10502, shortTermRent: "120" }],
  } as ManagerListingSubmissionV1);
  return {
    ...normalized,
    moveInFee: "11",
    paymentAtSigningByLeaseType: { [SHORT_TERM_LEASE_TERM]: signing },
  } as ManagerListingSubmissionV1;
}

afterEach(cleanup);

describe("a short stay's first payment is in the signing block only when it is collected at signing", () => {
  it("is not a signing line when the signing ticks leave it out, and the total ignores it", () => {
    const sub = stayListing(["move_in_fee"]);
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: SHORT_TERM_LEASE_TERM });
    const first = quote.signingLines.find((l) => l.label === "First stay payment")!;
    expect(first.dueAtSigning).toBe(false);
    const { atSigning, later } = splitQuoteLinesBySigning(quote);
    expect(atSigning.map((l) => l.label)).not.toContain("First stay payment");
    expect(later.map((l) => l.label)).toContain("First stay payment");
    expect(quote.signingTotal).toBe(atSigning.reduce((s, l) => s + l.amount, 0));
  });

  it("is a signing line and part of the total when ticked", () => {
    const sub = stayListing(["room_rent:room-a", "move_in_fee"]);
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: SHORT_TERM_LEASE_TERM });
    const { atSigning, later } = splitQuoteLinesBySigning(quote);
    expect(atSigning.map((l) => l.label)).toContain("First stay payment");
    expect(later.map((l) => l.label)).not.toContain("First stay payment");
    expect(quote.signingTotal).toBe(atSigning.reduce((s, l) => s + l.amount, 0));
  });

  it("agrees, line by line, with what the pay-before-signing step stamps as due at signing", () => {
    for (const signing of [["move_in_fee"], ["room_rent:room-a", "security_deposit"], []]) {
      const sub = stayListing(signing);
      const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: SHORT_TERM_LEASE_TERM });
      const ctx = { sub, leaseTerm: SHORT_TERM_LEASE_TERM, roomId: "room-a" };
      const byKey = (key: string) => quote.signingLines.find((l) => l.key === key);
      expect(byKey("room_rent:room-a")?.dueAtSigning).toBe(chargeKindDueAtSigning("stay_total", ctx));
      const deposit = byKey("security_deposit");
      if (deposit) expect(deposit.dueAtSigning).toBe(chargeKindDueAtSigning("security_deposit", ctx));
      const moveIn = byKey("move_in_fee");
      if (moveIn) expect(moveIn.dueAtSigning).toBe(chargeKindDueAtSigning("move_in_fee", ctx));
      const leaseFee = byKey("arrangement_lease_fee");
      if (leaseFee) expect(leaseFee.dueAtSigning).toBe(chargeKindDueAtSigning("lease_fee", ctx));
    }
  });
});

describe("What a resident pays: nothing sits in the signing block that the total ignores", () => {
  const renderPanel = (sub: ManagerListingSubmissionV1, plainReceipt: boolean) =>
    render(
      <PricingReceiptPanel
        sub={sub}
        patch={() => {}}
        leaseTerm={SHORT_TERM_LEASE_TERM}
        roomId="room-a"
        onRoomChange={() => {}}
        onLeaseTermChange={() => {}}
        leaseTerms={[LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM]}
        lockLeaseTerm
        plainReceipt={plainReceipt}
      />,
    );

  for (const plain of [true, false]) {
    it(`${plain ? "plain" : "editable"} receipt lists the unticked first stay payment under Due later`, () => {
      renderPanel(stayListing(["move_in_fee"]), plain);
      const total = screen.getByText("Total at signing");
      const later = screen.getByTestId("receipt-due-later");
      const first = screen.getByText("First stay payment");
      expect(later.contains(first)).toBe(true);
      expect(within(later).getByText("Due later")).toBeTruthy();
      // The signing block (everything above the total) has no first stay payment line.
      const position = first.compareDocumentPosition(total);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBe(0);
    });

    it(`${plain ? "plain" : "editable"} receipt keeps a ticked first stay payment above the total`, () => {
      renderPanel(stayListing(["room_rent:room-a", "move_in_fee", "security_deposit"]), plain);
      const total = screen.getByText("Total at signing");
      const first = screen.getByText("First stay payment");
      expect(first.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByTestId("receipt-due-later")).toBeNull();
    });
  }
});
