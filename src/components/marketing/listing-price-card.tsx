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
import { listingContactRows, listingPrimaryCtaClass } from "@/components/marketing/listing-contact-card";
import { ProspectListingCta } from "@/components/marketing/prospect-listing-cta";
import { QuickApplySheet } from "@/components/marketing/quick-apply-sheet";
import { ShortStayBookingBlock, useShortStay } from "@/components/marketing/short-stay-booking";
import { usePublicTexting } from "@/components/marketing/public-texting-context";
import { renterSmsHref } from "@/components/public-site/journey-paths";
import { DateField } from "@/components/ui/date-field";
import { Select } from "@/components/ui/input";
import type { ListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
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

/** True when the listing is leased as the whole home, so its bedrooms are read-only facts, not choices. */
function listingIsEntireHome(property: MockProperty): boolean {
  const sub = property.listingSubmission;
  return sub?.v === 1 && isEntireHomeListing(sub);
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
  // An entire-home listing is applied for as the whole place, so no bedroom of it is ever the unit
  // choice — the room a short stay is holding must not reach the application either.
  const entireHome = listingIsEntireHome(property);
  const roomId = entireHome ? "" : stay?.roomId ?? "";
  const readiness = useQuickApplyReadiness({
    enabled: quickEligible,
    propertyId: property.id,
    roomId,
    accountId: eligibility.accountId,
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
          initialRoomId={roomId}
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
  const roomId = listingIsEntireHome(property) ? "" : stay?.roomId ?? "";
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
    <div role="group" aria-label="Stay type" className="ps-ld-seg" data-attr="listing-stay-segments">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          data-attr={`listing-stay-${option.id}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** "$1,650 / mo" → the figure large, the unit small. The text content stays the one label. */
export function PriceFigure({ label, className = "", "data-attr": dataAttr }: { label: string; className?: string; "data-attr"?: string }) {
  const match = /^(.*?)(\s*\/\s*\S+)$/.exec(label);
  return (
    <p className={`ps-figure ps-ld-price ${className}`} data-attr={dataAttr}>
      {match ? (
        <>
          {match[1]}
          <span className="ps-ld-unit">{match[2]}</span>
        </>
      ) : (
        label
      )}
    </p>
  );
}

/**
 * "Text us": the listing's own work number when it has one (so the reply knows which home), otherwise the
 * PropLane line from the public layout. Null when neither is configured: the button is not drawn.
 */
export function useListingTextHref(property: MockProperty): string | null {
  const publicLine = usePublicTexting().phone;
  const own = listingContactRows(property).phone?.smsHref ?? null;
  if (own) return own;
  const title = property.buildingName?.trim() || property.title?.trim() || property.address?.trim() || "this home";
  return renterSmsHref(publicLine, `Hi PropLane, I'm interested in ${title}`);
}

export const BOOK_TOUR_LABEL = "Book a tour";

export function ListingPriceCard({
  property,
  rich,
  newTab,
  className = "",
  variant = "aside",
  showActions = true,
  availableLine = null,
}: {
  property: MockProperty;
  rich: ListingRichContent;
  newTab: boolean;
  className?: string;
  /** `aside` is the sticky desktop card (price first); `inline` is the phone's block of pickers under the overview. */
  variant?: "aside" | "inline";
  /** The phone dock carries the actions on the public page, so its inline block leaves them out. */
  showActions?: boolean;
  /** "Available now" / "Next opening Oct 24" — plain text under the price. */
  availableLine?: string | null;
}) {
  const stay = useShortStay();
  const actions = useListingActions();
  const textHref = useListingTextHref(property);
  const entireHome = listingIsEntireHome(property);
  const priceLine = listingMonthlyPriceLine(rich);
  const nightlyFrom = listingShortStayNightlyFrom(property.listingSubmission);
  // `stay.offered` already answers "is a short stay on offer" (a room to hold AND a nightly rate to
  // price it), which is the same answer the phone sticky bar reads.
  const segments = stay?.offered === true;
  const segment = segments && stay ? stay.segment : "monthly";
  const freeRooms = stay ? stay.rooms.filter((room) => stay.verdictFor(room.id)?.free !== false) : [];
  const today = pacificTodayKey();
  const inline = variant === "inline";
  const showFields = Boolean(stay) && !newTab && segment !== "short";
  const hasBody = segments || showFields || segment === "short" || showActions;
  if (inline && !hasBody) return null;

  return (
    <div
      className={`${inline ? "ps-card-soft ps-ld-inline" : "ps-card ps-ld-card"} ${className}`}
      data-attr={inline ? "listing-inline-card" : "listing-price-card"}
    >
      {!inline ? (
        segment === "short" ? (
          <PriceFigure label={`from $${nightlyFrom.toLocaleString("en-US")} / night`} data-attr="listing-price-line" />
        ) : priceLine ? (
          <PriceFigure label={priceLine.label} data-attr="listing-price-line" />
        ) : null
      ) : null}
      {!inline && availableLine ? (
        <p className="ps-ld-avail" data-attr="listing-available-line">
          {availableLine}
        </p>
      ) : null}
      {segments && stay ? <SegmentControl value={stay.segment} onChange={stay.setSegment} /> : null}

      {segment === "short" ? (
        <ShortStayBookingBlock className="mt-4" quickBook={actions?.quickEligible ? actions.identity : null} />
      ) : (
        <>
          {showFields && stay ? (
            <div className="ps-ld-fields" data-attr="listing-monthly-fields">
              <label data-attr="listing-move-in">
                Move-in
                <DateField value={stay.moveIn} onChange={stay.setMoveIn} min={today} className="mt-1" aria-label="Move-in" />
              </label>
              {!entireHome && stay.rooms.length > 1 ? (
                <label data-attr="listing-room-select">
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
          {showActions ? (
            <div className="ps-ld-acts">
              <ProspectListingCta action="tour" propertyId={property.id} data-attr="listing-web-tour" className="ps-btn ps-btn-blue" newTab={newTab}>
                {BOOK_TOUR_LABEL}
              </ProspectListingCta>
              <MonthlyPrimaryCta property={property} newTab={newTab} className="ps-btn ps-btn-line" />
              {textHref ? (
                <a href={textHref} className="ps-btn ps-btn-line" data-attr="listing-text-tour">
                  Text us
                </a>
              ) : null}
              {segments && stay ? (
                <button type="button" className="ps-link ps-ld-more" data-attr="listing-book-short-term" onClick={() => stay.setSegment("short")}>
                  Book short term
                </button>
              ) : null}
            </div>
          ) : segments && stay ? (
            <button type="button" className="ps-link ps-ld-more" data-attr="listing-book-short-term" onClick={() => stay.setSegment("short")}>
              Book short term
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
