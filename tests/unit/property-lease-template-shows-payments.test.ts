/**
 * PRP-124 — "the lease that is auto generated does not include payments
 * specifically", on the Property → Lease tab.
 *
 * The template preview stands in for a placement that has not happened, so it
 * shows "Filled at placement" where a PLACEMENT decides the answer. One flag was
 * doing that job for the address, the room AND every financial — so a manager
 * opening their own lease template saw a payment section of em dashes.
 *
 * Rent, utilities, deposit, move-in fee and the fee schedule are configured on
 * the LISTING, not chosen at placement. They are facts the template already
 * knows, and they now render. Proration is the one money figure that stays
 * blank, because it is computed from move-in and move-out dates a template does
 * not have.
 */
import { describe, expect, it } from "vitest";
import { buildPropertyLeasePreview, PROPERTY_LEASE_TEMPLATE_PLACEHOLDER } from "@/lib/property-lease-preview";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";

/** The listing a manager configured, as the Property → Lease tab would pass it. */
function listingSubmission() {
  return {
    ...createDefaultListingSubmission(),
    buildingName: "Brooklyn House",
    address: "5259 Brooklyn Ave NE, Seattle, WA 98105",
    city: "Seattle",
    state: "WA",
    zip: "98105",
    securityDeposit: "900",
    moveInFee: "250",
    rooms: [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 1450,
        utilitiesEstimate: "180",
      },
    ],
  };
}

describe("the property lease template states its payments", () => {
  const html = buildPropertyLeasePreview(listingSubmission(), { templateKind: "long-term" }).html ?? "";

  it("produces a lease at all", () => {
    expect(html.length).toBeGreaterThan(500);
  });

  it("shows the rent the listing is configured with", () => {
    expect(html).toMatch(/1,450|1450/);
  });

  it("shows the deposit and the move-in fee", () => {
    expect(html).toContain("900");
    expect(html).toContain("250");
  });

  it("leaves no MONEY row as an em dash", () => {
    // Counting dashes would be wrong — the addendum titles legitimately contain
    // one ("Addendum A — Move-In Condition Report"), and identity rows are
    // SUPPOSED to be blank. What must not be blank is a financial row, so each
    // one is checked by its own label.
    const rows = html
      .split("\n")
      .map((line) => line.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    for (const label of ["Security deposit", "Move-in fee", "Monthly rent"]) {
      const row = rows.find((line) => line.startsWith(label));
      if (!row) continue; // an optional line the template genuinely omits
      expect(row, `${label} should carry a figure`).not.toMatch(/^\S.*—\s*$/);
    }
  });

  it("the em dashes that remain are identity, which SHOULD be blank", () => {
    expect(html).toMatch(/Resident:\s*(<[^>]+>\s*)*—/);
  });

  it("still says 'Filled at placement' for what a PLACEMENT decides", () => {
    // Who, where and which room are not template facts.
    expect(html).toContain(PROPERTY_LEASE_TEMPLATE_PLACEHOLDER);
  });
});
