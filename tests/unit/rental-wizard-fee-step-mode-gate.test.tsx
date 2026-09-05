/**
 * @vitest-environment jsdom
 *
 * The fee step's inline (embedded) Stripe payment renders for BOTH live apply
 * surfaces — the public apply page AND the resident portal apply wizard (a
 * portal applicant must never be dead-ended with no way to pay) — and NEVER
 * for the portal's read-back editor of an already-submitted application. The
 * headline amount comes from the gate (server-derived), not the listing's
 * grandfathered `applicationFee` text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/marketing/application-fee-inline-payment", () => ({
  ApplicationFeeInlinePayment: () => <div data-testid="inline-payment" />,
}));

import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

const PID = "prop-mode-gate";

function seedListing(overrides: Partial<ReturnType<typeof createDefaultListingSubmission>> = {}): void {
  const sub = createDefaultListingSubmission();
  sub.applicationFee = "$50";
  sub.axisPaymentsEnabled = true;
  Object.assign(sub, overrides);
  const property: MockProperty = {
    id: PID,
    title: "Mode Gate Flat",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Mode Gate Flat",
    unitLabel: "Unit 1",
    adminPublishLive: true,
    managerUserId: "mgr-mode-gate",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

function renderFeeStep(
  mode: "public" | "portal" | "editor",
  gate?: Partial<WizardStepsProps["applicationFeeGate"] & { pending?: boolean }>,
  opts: {
    payChannel?: "ach" | "zelle" | "venmo" | "other";
    subOverrides?: Partial<ReturnType<typeof createDefaultListingSubmission>>;
  } = {},
) {
  seedListing(opts.subOverrides);
  const form = {
    ...createInitialRentalWizardState(),
    propertyId: PID,
    email: "dana@example.com",
    fullLegalName: "Dana Tenant",
    applicationFeePayChannel: opts.payChannel ?? ("ach" as const),
  };
  const noop = () => {};
  return render(
    <RentalWizardStepBody
      // The fee step is step 11, not 12. The wizard was renumbered to
      // RENTAL_WIZARD_STEP_COUNT = 11 (the old value survives only as
      // LEGACY_RENTAL_WIZARD_STEP_COUNT for migrating saved progress), and
      // RentalWizardStepBody returns null for any step past the count — so a
      // stale 12 here renders NOTHING and every query below comes back null
      // rather than failing on the thing it means to assert.
      step={11}
      form={form}
      errors={{}}
      mode={mode}
      propertyOptions={[]}
      patch={noop}
      applicationFeeGate={{
        needsFee: true,
        paid: false,
        displayLabel: "$75.00",
        amount: 75,
        waived: false,
        pending: false,
        ...gate,
      }}
      occupancySyncEpoch={0}
      showAvailabilityWarnings={false}
      setPhone={noop}
      setLandlordPhone={noop}
      setPrevLandlordPhone={noop}
      setSupervisorPhone={noop}
      setRef1Phone={noop}
      setRef2Phone={noop}
      setSsn={noop}
      goToStep={noop}
      editFromReview={noop}
    />,
  );
}

afterEach(() => cleanup());

describe("fee step — inline payment mode gate", () => {
  it("renders the inline payment on the public apply surface", () => {
    renderFeeStep("public");
    expect(screen.queryByTestId("inline-payment")).toBeTruthy();
  });

  it("renders the inline payment on the portal apply surface (no dead-end)", () => {
    renderFeeStep("portal");
    expect(screen.queryByTestId("inline-payment")).toBeTruthy();
  });

  it("never renders a payment in the submitted-application editor", () => {
    renderFeeStep("editor");
    expect(screen.queryByTestId("inline-payment")).toBeNull();
  });

  it("never renders the inline payment once the fee is paid — the double-charge guard", () => {
    renderFeeStep("public", { paid: true });
    expect(screen.queryByTestId("inline-payment")).toBeNull();
    expect(screen.queryByText("Paid")).toBeTruthy();
  });

  it("hides the manual-channel payment UI (instructions, channel picker, Check payment) once paid", () => {
    renderFeeStep(
      "public",
      { paid: true },
      { payChannel: "zelle", subOverrides: { zellePaymentsEnabled: true, zelleContact: "pay@zelle.example" } },
    );
    expect(screen.queryByText(/Send by Zelle/)).toBeNull();
    expect(screen.queryByText(/Check payment|Payment received/)).toBeNull();
    expect(screen.queryByText("Payment method")).toBeNull();
    expect(screen.queryByText("Paid")).toBeTruthy();
  });

  it("shows NO manual-channel instructions even while the fee is unpaid", () => {
    // bc91cc80 made checkout Stripe-only. The manual Zelle/Venmo path is gone, so
    // an applicant is never told to send money outside the platform — not even on
    // a listing whose stored config still carries a zelle contact. The unpaid case
    // is the one that matters: it is where the old flow put the instructions.
    renderFeeStep(
      "public",
      {},
      { payChannel: "zelle", subOverrides: { zellePaymentsEnabled: true, zelleContact: "pay@zelle.example" } },
    );
    expect(screen.queryByText(/Send by Zelle/)).toBeNull();
    expect(screen.queryByText("pay@zelle.example")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check payment" })).toBeNull();
  });

  it("shows no payment UI (not even the resolving placeholder) when paid, even mid-resolve", () => {
    renderFeeStep("public", { paid: true, pending: true });
    expect(screen.queryByTestId("inline-payment")).toBeNull();
    expect(screen.queryByText(/Confirming the application fee/)).toBeNull();
  });

  it("holds payment UI while the server fee is still resolving", () => {
    renderFeeStep("public", { pending: true, displayLabel: "…" });
    expect(screen.queryByTestId("inline-payment")).toBeNull();
    expect(screen.queryByText(/Confirming the application fee/)).toBeTruthy();
  });

  it("headlines the gate's (server-derived) amount, not the listing's stored fee text", () => {
    renderFeeStep("public");
    expect(screen.queryByText("$75.00")).toBeTruthy();
    expect(screen.queryByText("$50")).toBeNull();
  });
});
