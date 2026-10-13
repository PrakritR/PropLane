"use client";

/**
 * The public listing's price card: one card, no dead rows.
 *
 * A price line at the top ("$1,050 / mo", or "from $1,050 / mo" when the base rent is zero and the price is
 * the lowest room rent; never a dash or "$0"), a Monthly | Short stay segmented control when the listing
 * has a nightly rate, and under the segment only what that stay needs. Monthly: move-in, room, one primary
 * (Quick apply for a signed-in resident with saved answers, Continue application when those answers do not
 * cover the listing, Apply otherwise), Schedule tour, and the work number as a text link. Short stay:
 * the booking block, whose primary is Request to book (Quick book for the same resident).
 *
 * `ListingActionsProvider` decides the primary once for the whole page, so the card (drawn twice by width)
 * and the phone's sticky bar always agree and the read-only server check runs once.
 */
import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { listingContactRows, listingPrimaryCtaClass, listingSecondaryCtaClass, listingTextLinkClass } from "@/components/marketing/listing-contact-card";
import { ProspectListingCta } from "@/components/marketing/prospect-listing-cta";
import { QuickApplySheet } from "@/components/marketing/quick-apply-sheet";
import { ShortStayBookingBlock, useShortStay } from "@/components/marketing/short-stay-booking";
import { formatMoneyInLabel } from "@/components/marketing/listing-key-facts";
import { DateField } from "@/components/ui/date-field";
import { Select } from "@/components/ui/input";
import type { ListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";
import {
  useQuickApplyEligibility,
  useQuickApplyReadiness,
  type QuickApplyIdentity,
  type QuickApplyReadiness,
} from "@/hooks/use-quick-apply-eligibility";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { listingMonthlyPriceLine } from "@/lib/listing-price-line";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";
import { listingShortStayNightlyFrom } from "@/lib/short-stay-request";

type ListingActions = {
  /** A signed-in resident with saved answers, on the public page (never a manager's own preview). */
  quickEligible: boolean;
  readiness: QuickApplyReadiness;
  identity: QuickApplyIdentity;
  openQuickApply: () => void;
};

const ActionsCtx = createContext<ListingActions | null>(null);

export function useListingActions(): ListingActions | null {
  return useContext(ActionsCtx);
}

export function ListingActionsProvider({
  property,
  preview,
  children,
}: {
  property: MockProperty;
  /** The manager's own preview: nothing applies from it. */
  preview: boolean;
  children: ReactNode;
}) {
  const stay = useShortStay();
  const showToast = useOptionalAppUi()?.showToast ?? (() => undefined);
  const eligibility = useQuickApplyEligibility();
  const quickEligible = eligibility.eligible && !preview;
  const readiness = useQuickApplyReadiness({
    enabled: quickEligible,
    propertyId: property.id,
    roomId: stay?.roomId ?? "",
  });
  const [open, setOpen] = useState(false);
  const openQuickApply = useCallback(() => setOpen(true), []);
  const value = useMemo<ListingActions>(
    () => ({ quickEligible, readiness, identity: eligibility.identity, openQuickApply }),
    [quickEligible, readiness, eligibility.identity, openQuickApply],
  );
  return (
    <ActionsCtx.Provider value={value}>
      {children}
      {quickEligible ? (
        <QuickApplySheet
          open={open}
          onClose={() => setOpen(false)}
          propertyId={property.id}
          submission={property.listingSubmission ?? null}
          initialRoomId={stay?.roomId}
          initialMoveIn={stay?.moveIn}
          showToast={showToast}
        />
      ) : null}
    </ActionsCtx.Provider>
  );
}

/**
 * The monthly segment's one primary button. Quick apply opens the sheet; Continue application and View
 * application are plain links to where the server said to go; Apply is the existing door.
 */
export function MonthlyPrimaryCta({
  property,
  newTab,
  className = listingPrimaryCtaClass,
  label,
}: {
  property: MockProperty;
  newTab: boolean;
  className?: string;
  /** A shorter word for the phone bar; the long name stays for a screen reader. */
  label?: "short";
}) {
  const actions = useListingActions();
  const stay = useShortStay();
  const roomId = stay?.roomId ?? "";
  const words = (long: string, short: string) => (
    label === "short" ? (
      <>
        <span aria-hidden>{short}</span>
        <span className="sr-only">{long}</span>
      </>
    ) : (
      long
    )
  );
  if (actions?.quickEligible && (actions.readiness.kind === "checking" || actions.readiness.kind === "ready")) {
    return (
      <button type="button" className={className} onClick={actions.openQuickApply} data-attr="listing-quick-apply">
        {words("Quick apply", "Quick apply")}
      </button>
    );
  }
  if (actions?.quickEligible && actions.readiness.kind === "continue") {
    return (
      <Link href={actions.readiness.href} className={className} data-attr="listing-continue-application">
        {words("Continue application", "Continue")}
      </Link>
    );
  }
  if (actions?.quickEligible && actions.readiness.kind === "applied") {
    return (
      <Link href={actions.readiness.href} className={className} data-attr="listing-view-application">
        {words("View application", "Applied")}
      </Link>
    );
  }
  return (
    <ProspectListingCta
      action="apply"
      propertyId={property.id}
      data-attr="listing-web-apply"
      className={className}
      newTab={newTab}
      applyParams={roomId ? { listingRoomId: roomId } : undefined}
    >
      {words("Apply", "Apply")}
    </ProspectListingCta>
  );
}

function SegmentControl({ value, onChange }: { value: "monthly" | "short"; onChange: (next: "monthly" | "short") => void }) {
  const options = [
    { id: "monthly" as const, label: "Monthly" },
    { id: "short" as const, label: "Short stay" },
  ];
  return (
    <div role="group" aria-label="Stay type" className="mt-3 grid grid-cols-2 rounded-full border border-border bg-accent/30 p-0.5" data-attr="listing-stay-segments">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          data-attr={`listing-stay-${option.id}`}
          className="min-h-[40px] rounded-full px-3 text-[13px] font-semibold text-muted transition aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ListingPriceCard({
  property,
  rich,
  newTab,
  className = "",
}: {
  property: MockProperty;
  rich: ListingRichContent;
  newTab: boolean;
  className?: string;
}) {
  const stay = useShortStay();
  const actions = useListingActions();
  const priceLine = listingMonthlyPriceLine(rich);
  const estimated = rich.estimatedMonthlyTotalLabel?.trim() ? formatMoneyInLabel(rich.estimatedMonthlyTotalLabel.trim()) : undefined;
  const breakdownLines = rich.pricingBreakdown ?? [];
  const nightlyFrom = listingShortStayNightlyFrom(property.listingSubmission);
  const segments = stay?.offered === true && nightlyFrom > 0;
  const segment = segments && stay ? stay.segment : "monthly";
  const contact = listingContactRows(property).phone;
  const freeRooms = stay ? stay.rooms.filter((room) => stay.verdictFor(room.id)?.free !== false) : [];
  const today = pacificTodayKey();

  return (
    <div className={`overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm listing-detail-surface ${className}`} data-attr="listing-price-card">
      {segment === "short" ? (
        <p className="text-3xl font-bold tracking-tight text-foreground" data-attr="listing-price-line">
          from ${nightlyFrom.toLocaleString("en-US")}
          <span className="ml-1 text-sm font-semibold text-muted">/ night</span>
        </p>
      ) : priceLine ? (
        <p className="text-3xl font-bold tracking-tight text-foreground" data-attr="listing-price-line">
          {priceLine.label}
        </p>
      ) : null}
      {segments && stay ? <SegmentControl value={stay.segment} onChange={stay.setSegment} /> : null}

      {segment === "short" ? (
        <ShortStayBookingBlock embedded className="mt-4" quickBook={actions?.quickEligible ? actions.identity : null} />
      ) : (
        <>
          {estimated || breakdownLines.length > 0 ? (
            <dl className="mt-3 divide-y divide-border border-y border-border text-sm">
              {estimated ? (
                <div className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-muted">Est. with utilities</dt>
                  <dd className="font-bold tracking-tight text-foreground">{estimated}</dd>
                </div>
              ) : null}
              {breakdownLines.map((line) => (
                <div key={line.label} className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="text-muted">{line.label}</dt>
                  <dd className="font-bold tracking-tight text-foreground">{formatMoneyInLabel(line.value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {stay && !newTab ? (
            <div className="mt-4 grid grid-cols-1 gap-2.5" data-attr="listing-monthly-fields">
              <label className="block min-w-0 text-xs font-semibold text-muted" data-attr="listing-move-in">
                Move-in
                <DateField value={stay.moveIn} onChange={stay.setMoveIn} min={today} className="mt-1" aria-label="Move-in" />
              </label>
              {stay.rooms.length > 1 ? (
                <label className="block min-w-0 text-xs font-semibold text-muted" data-attr="listing-room-select">
                  Room
                  <Select aria-label="Room" className="mt-1" value={stay.roomId} onChange={(e) => stay.setRoomId(e.target.value)}>
                    <option value="">Any room</option>
                    {freeRooms.map((room) => (
                      <option key={room.id} value={room.id}>{room.name}</option>
                    ))}
                  </Select>
                </label>
              ) : null}
            </div>
          ) : null}
          <div className="mt-4 space-y-2.5">
            <MonthlyPrimaryCta property={property} newTab={newTab} />
            {segments && stay ? (
              <button type="button" className={listingSecondaryCtaClass} data-attr="listing-book-short-term" onClick={() => stay.setSegment("short")}>
                Book short term
              </button>
            ) : null}
            <ProspectListingCta action="tour" propertyId={property.id} data-attr="listing-web-tour" className={listingSecondaryCtaClass} newTab={newTab}>
              Schedule tour
            </ProspectListingCta>
          </div>
          {contact ? (
            <a href={contact.smsHref} className={listingTextLinkClass} data-attr="listing-text-tour">
              Text {contact.label}
            </a>
          ) : null}
        </>
      )}
    </div>
  );
}
