"use client";

/**
 * The ONE field list a priced thing shows for one lease type section.
 *
 * A single-occupant room, a bundle and the whole house all draw this component, so the three can
 * never drift apart (captain, Oct 3: "application fee, lease fee, move-in fee, month-to-month
 * surcharge, custom start surcharge etc. - have the same for bundles as well as individual
 * rooms"). Each caller only supplies an adapter that says where its values are stored:
 *
 *  - Long-term: Rent, Utilities, Deposit, the other fees, Partial months, Lease fee, Application fee,
 *    Move-in fee, Month-to-month surcharge, Custom start surcharge.
 *  - Short-term: Nightly rate, Deposit, the other fees, Lease fee, Application fee, Move-in fee.
 *
 * Three rows follow what the listing OFFERS (the same lease checkboxes `allowedLeaseTerms` carries):
 * Partial months and Custom start surcharge show only when custom dates are allowed, Month-to-month
 * surcharge only when month-to-month is. Nothing else here is conditional.
 */
import { ArrangementStandardFeeRows, type ArrangementFeePatch } from "@/components/portal/listing-wizard-v2/arrangement-standard-fee-rows";
import { FeeRows, ProrateRows, type DayRate } from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import { FactRow, MoneyInput } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { templateFeeDefaults } from "@/lib/form-template-fees";
import { listingPricingTabToLeaseTerm } from "@/lib/listing-fee-scope";
import { MONTH_TO_MONTH_PRICING_TERM } from "@/lib/pricing-lease-options";
import { isStayLeaseTerm } from "@/lib/listing-quote";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { RoomOccupancyPrice } from "@/lib/room-arrangement-pricing";
import type { RoomPricingFeeVisibility } from "@/lib/room-term-fees";

/** One money box: its accessible name, what it shows and where a keystroke goes. */
export type PricingMoneyField = { label: string; value: string; onChange: (value: string) => void };

/** Where one priced thing (a room, a bundle, the whole house) keeps the values this component draws. */
export type PricingSubjectAdapter = {
  rent: PricingMoneyField;
  utilities: PricingMoneyField;
  deposit: PricingMoneyField;
  nightly: PricingMoneyField;
  shortDeposit: PricingMoneyField;
  /** The scope the "other fees" rows are added under: a room id, a bundle id, or null for the whole house. */
  feeScope: { roomId: string | null; roomName?: string };
  /** Partial months: the thing's name for the boxes' labels, the answer and the per-day rates. */
  prorate: {
    name: string;
    dataAttr: string;
    automatic: boolean;
    onAutomatic: (next: boolean) => void;
    rent: DayRate;
    util: DayRate | null;
  };
  /** Lease / Application / Move-in fees and the two surcharges, for the section being drawn. */
  standardFees: {
    row: RoomOccupancyPrice;
    onPatch: (patch: ArrangementFeePatch) => void;
    storage?: "term" | "stayFields";
    inheritedRow?: Partial<Record<"leaseFee" | "applicationFee", string>>;
  };
};

export function PricingSubjectFields({
  draft,
  patch,
  term,
  visibility,
  adapter,
}: {
  draft: ManagerListingSubmissionV1;
  patch: (next: Partial<ManagerListingSubmissionV1>) => void;
  /** The pricing section's term id: Long-term or Short term. */
  term: string;
  visibility: RoomPricingFeeVisibility;
  adapter: PricingSubjectAdapter;
}) {
  const quoteTerm = listingPricingTabToLeaseTerm(term) ?? LONG_TERM_LEASE_TERM;
  const isStay = isStayLeaseTerm(quoteTerm);
  const isBaseLong = quoteTerm === LONG_TERM_LEASE_TERM;
  const isMonthToMonth = quoteTerm === MONTH_TO_MONTH_PRICING_TERM;
  const { standardFees, feeScope, prorate } = adapter;
  const money = (label: string, field: PricingMoneyField) => (
    <FactRow label={label}>
      <MoneyInput label={field.label} value={field.value} onChange={field.onChange} />
    </FactRow>
  );
  const fees = <FeeRows sub={draft} patch={patch} roomId={feeScope.roomId} roomName={feeScope.roomName} term={quoteTerm} />;
  const standard = (
    <ArrangementStandardFeeRows
      count={1}
      row={standardFees.row}
      onPatch={standardFees.onPatch}
      // Custom start sits on the Long-term tab (custom dates are an option of the long-term lease).
      // Short-term and Month-to-month carry no surcharge.
      showCustomStart={isBaseLong && visibility.customStartSurcharge}
      scope={isStay ? "short" : "long"}
      storage={standardFees.storage}
      inheritedRow={standardFees.inheritedRow}
      templateDefaults={templateFeeDefaults(draft, quoteTerm)}
    />
  );
  if (isMonthToMonth) {
    // Month-to-month follows the Long-term rent, utilities and deposit; its tab holds only its own fees.
    return <>{standard}</>;
  }
  if (isStay) {
    return (
      <>
        {money("Nightly rate", adapter.nightly)}
        {money("Deposit", adapter.shortDeposit)}
        {fees}
        {standard}
      </>
    );
  }
  return (
    <>
      {money("Rent /mo", adapter.rent)}
      {money("Utilities /mo", adapter.utilities)}
      {money("Deposit", adapter.deposit)}
      {fees}
      {isBaseLong && visibility.partialMonths ? (
        <ProrateRows
          sub={draft}
          patch={patch}
          term={quoteTerm}
          roomId={feeScope.roomId}
          name={prorate.name}
          automatic={prorate.automatic}
          onAutomatic={prorate.onAutomatic}
          rent={prorate.rent}
          util={prorate.util}
          dataAttr={prorate.dataAttr}
        />
      ) : null}
      {standard}
    </>
  );
}
