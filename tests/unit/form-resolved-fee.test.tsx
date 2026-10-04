// @vitest-environment jsdom
//
// The application form and the lease form show the fee they charge READ-ONLY, from the one placement resolver
// (Pricing owns it), with a link to Pricing - there is no second fee field on a form to drift from the first.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PropertyFormFeeForCurrentForm, PropertyFormResolvedFee } from "@/components/portal/property-form-resolved-fee";
import { resolvedFormFeeForTerm, resolvedFormFees } from "@/lib/form-resolved-fee";
import { placementApplicationFeeCents, placementFeeOptionsFor } from "@/lib/listing-placement-standard-fees";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

afterEach(cleanup);

function listing(rooms: Partial<ManagerRoomSubmission>[], listingFee = "35") {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.applicationFee = listingFee;
  sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM];
  const base = sub.rooms[0]!;
  sub.rooms = rooms.map((room, i) => ({ ...base, id: `room-${i + 1}`, name: `Unit ${i + 1}`, monthlyRent: 1100, ...room }) as ManagerRoomSubmission);
  return normalizeManagerListingSubmissionV1(sub);
}

const ONE_ROOM = listing([
  {
    occupancyPrices: [{ count: 1, applicationFee: "40", leaseFee: "150" }],
    termPricing: { [SHORT_TERM_LEASE_TERM]: { applicationFee: "15", leaseFee: "60" } },
  },
]);

describe("the fee a form shows is the resolver's answer", () => {
  it("reads each stay type's own application and lease fee from Pricing", () => {
    expect(resolvedFormFeeForTerm(ONE_ROOM, "application", LONG_TERM_LEASE_TERM)).toMatchObject({ display: "$40", set: true });
    expect(resolvedFormFeeForTerm(ONE_ROOM, "application", SHORT_TERM_LEASE_TERM)).toMatchObject({ display: "$15" });
    expect(resolvedFormFeeForTerm(ONE_ROOM, "lease", LONG_TERM_LEASE_TERM)).toMatchObject({ display: "$150" });
    expect(resolvedFormFeeForTerm(ONE_ROOM, "lease", SHORT_TERM_LEASE_TERM)).toMatchObject({ display: "$60" });
  });

  it("agrees with the one resolver the checkout uses, to the cent", () => {
    const room = ONE_ROOM.rooms[0]!;
    for (const term of [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM]) {
      const charged = placementApplicationFeeCents(ONE_ROOM, placementFeeOptionsFor(ONE_ROOM, { room, leaseTerm: term }));
      const shown = resolvedFormFeeForTerm(ONE_ROOM, "application", term);
      expect([shown.minCents, shown.maxCents]).toEqual([charged, charged]);
    }
  });

  it("a stay type that sets nothing falls back to the listing fee for an application, and 'None' for a lease", () => {
    const sub = listing([{}], "35");
    expect(resolvedFormFeeForTerm(sub, "application", LONG_TERM_LEASE_TERM)).toMatchObject({ display: "$35" });
    expect(resolvedFormFeeForTerm(sub, "lease", LONG_TERM_LEASE_TERM)).toMatchObject({ display: "None", maxCents: 0 });
  });

  it("an application fee nothing sets reads 'Account default', never a false $0", () => {
    const sub = listing([{}], "");
    expect(resolvedFormFeeForTerm(sub, "application", LONG_TERM_LEASE_TERM)).toMatchObject({ display: "Account default", set: false });
  });

  it("rooms that differ show a range", () => {
    const sub = listing([
      { occupancyPrices: [{ count: 1, applicationFee: "25" }] },
      { occupancyPrices: [{ count: 1, applicationFee: "45" }] },
    ]);
    expect(resolvedFormFees(sub, "application", [LONG_TERM_LEASE_TERM])[0]).toMatchObject({ display: "$25-$45", minCents: 2500, maxCents: 4500 });
  });
});

describe("the read-only fee card", () => {
  it("shows one row per stay type, no input, and a link to the property's Pricing", () => {
    const { container } = render(
      <PropertyFormResolvedFee sub={ONE_ROOM} kind="application" terms={[LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM]} propertyId="prop-7" />,
    );
    expect(screen.getByText("Application fee")).toBeTruthy();
    expect(screen.getByText("$40")).toBeTruthy();
    expect(screen.getByText("$15")).toBeTruthy();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    const link = screen.getByRole("link", { name: "Edit in Pricing" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/portal/properties/all/prop-7/pricing");
    // New tab: an unsaved form is never lost to the click.
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders nothing for a form no stay type uses", () => {
    const { container } = render(<PropertyFormResolvedFee sub={ONE_ROOM} kind="lease" terms={[]} propertyId="prop-7" />);
    expect(container.innerHTML).toBe("");
  });

  it("a lease form lists the stay types routed to it and only those", () => {
    const longLease = { ...createPropertyLeaseTemplate({ kind: "long-term", label: "Long lease" }), id: "lease-long", applicationLeaseTerms: [LONG_TERM_LEASE_TERM] };
    const shortLease = { ...createPropertyLeaseTemplate({ kind: "short-term", label: "Short lease" }), id: "lease-short", applicationLeaseTerms: [SHORT_TERM_LEASE_TERM] };
    const app = { ...createPropertyApplicationTemplate({ kind: "long-term", label: "Long app" }), id: "app-long" };
    render(
      <PropertyFormFeeForCurrentForm
        sub={ONE_ROOM}
        mode="lease"
        currentId="lease-short"
        leaseTemplates={[longLease, shortLease]}
        applicationTemplates={[app]}
        propertyId="prop-7"
      />,
    );
    expect(screen.getByText("Lease fee")).toBeTruthy();
    expect(screen.getByText("$60")).toBeTruthy();
    expect(screen.queryByText("$150")).toBeNull();
  });
});
