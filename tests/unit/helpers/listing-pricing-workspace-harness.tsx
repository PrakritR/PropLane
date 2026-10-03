/**
 * Pricing left the listing wizard rail (studio redesign 0929). Behaviour tests
 * mount the property Payments surface: pricing columns + receipt panel.
 */
import React, { useState } from "react";
import { render } from "@testing-library/react";
import { ListingPricingWorkspace } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PricingReceiptPanel } from "@/components/portal/listing-wizard-v2/listing-side-panel";
import {
  createDefaultListingSubmission,
  resolveAllowedLeaseTerms,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { houseDefaultsForSubmission, type ListingHouseDefaults } from "@/lib/listing-house-defaults";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

export function ListingPricingHarness({
  initial,
  onChange,
  plainReceipt = false,
}: {
  initial?: ManagerListingSubmissionV1 | (() => ManagerListingSubmissionV1);
  onChange?: (sub: ManagerListingSubmissionV1) => void;
  /** Property tab uses plain receipt (C2-R30-9); wizard-style tests pass false. */
  plainReceipt?: boolean;
}) {
  const [sub, setSub] = useState<ManagerListingSubmissionV1>(() =>
    typeof initial === "function" ? initial() : (initial ?? createDefaultListingSubmission()),
  );
  const [defaults, setDefaults] = useState<ListingHouseDefaults>(() => houseDefaultsForSubmission(sub));
  const [leaseTerm, setLeaseTerm] = useState(() => resolveAllowedLeaseTerms(sub)[0] ?? LONG_TERM_LEASE_TERM);
  const [quoteRoomId, setQuoteRoomId] = useState<string | null>(null);
  const patch = (next: Partial<ManagerListingSubmissionV1>) => {
    setSub((prev) => {
      const merged = { ...prev, ...next };
      onChange?.(merged);
      return merged;
    });
  };
  const leaseTerms = resolveAllowedLeaseTerms(sub);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <ListingPricingWorkspace
        sub={sub}
        patch={patch}
        defaults={defaults}
        setDefaults={setDefaults}
        onActiveLeaseTermChange={setLeaseTerm}
      />
      <PricingReceiptPanel
        sub={sub}
        patch={patch}
        roomId={quoteRoomId}
        leaseTerm={leaseTerm}
        onRoomChange={setQuoteRoomId}
        onLeaseTermChange={setLeaseTerm}
        leaseTerms={leaseTerms}
        lockLeaseTerm
        plainReceipt={plainReceipt}
      />
    </div>
  );
}

export function renderListingPricing(
  opts: {
    initial?: ManagerListingSubmissionV1 | (() => ManagerListingSubmissionV1);
    onChange?: (sub: ManagerListingSubmissionV1) => void;
    plainReceipt?: boolean;
  } = {},
) {
  return render(<ListingPricingHarness {...opts} />);
}
