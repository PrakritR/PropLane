"use client";

/**
 * The booking record page (PLAN-0920-1058, area 1e) — Overview · Guest ·
 * Charges + the shared Communication · Documents · Activity trio, on the
 * generic record shell (docs/agents/record-page.md).
 *
 * A booking has no id of its own; the route reuses `bookingEntryKey` (see
 * `bookingRecordHref`). Only a block-sourced booking (a manager-made hold,
 * `entry.blockId`) can actually be edited here — a signed lease's dates
 * belong to the Lease record and a channel import is owned by Airbnb, so
 * Edit dates / Move room / Cancel fall back to "Coming soon" for those
 * (docs/agents/record-page.md § Known gap). "Record payment" is dropped
 * entirely rather than shown as a dead action: nothing here has a verified
 * charge path yet.
 */

import { useMemo, useState } from "react";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { BookingsEditDatesSheet } from "@/components/portal/bookings-edit-dates-sheet";
import { BookingsMoveRoomSheet } from "@/components/portal/bookings-move-room-sheet";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { CreditCard } from "lucide-react";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  addDaysToDateKey,
  bookingEntryKey,
  bookingOpenTarget,
  bookingSourceLabel,
  formatBookingStayRange,
} from "@/lib/channel-calendar/bookings-ui";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { managerBookingListHref, parseBookingDetailTab } from "@/lib/portal-detail-routes";
import { FileSignature, Home } from "lucide-react";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="min-w-0 truncate text-right text-[13.5px]">{value || "—"}</span>
    </div>
  );
}

function guestName(entry: PropertyBookingEntry): string {
  return entry.source === "airbnb" || entry.source === "booking_com"
    ? bookingGuestLabel(entry.summary, entry.source)
    : entry.summary;
}

export function BookingsRecordPage({
  bookingId,
  tab: tabProp,
  basePath,
  entries,
  loading,
  residentOptions,
  onSaveBlock,
  onRemoveBlock,
  showToast,
}: {
  bookingId: string;
  tab?: string;
  basePath: string;
  entries: readonly PropertyBookingEntry[];
  loading: boolean;
  residentOptions: readonly BlockDatesResidentOption[];
  onSaveBlock: (draft: {
    id?: string;
    propertyId: string;
    roomId: string;
    checkIn: string;
    checkOut: string;
    reason: string;
    residentName: string;
    residentEmail: string;
  }) => Promise<void>;
  onRemoveBlock: (blockId: string) => Promise<void>;
  showToast: (message: string) => void;
}) {
  const navigate = usePortalNavigate();
  const confirm = useConfirm();
  const [sheet, setSheet] = useState<"dates" | "room" | null>(null);

  const entry = useMemo(
    () => entries.find((candidate) => bookingEntryKey(candidate) === bookingId) ?? null,
    [entries, bookingId],
  );

  if (!entry) {
    if (loading) return <PortalDataTableEmpty icon="default" message="Loading…" />;
    return <PortalDataTableEmpty icon="default" message="Booking not found." />;
  }

  const tab = parseBookingDetailTab(tabProp);
  const name = guestName(entry);
  const isBlock = entry.source === "block" && Boolean(entry.blockId);
  const resident = residentOptions.find(
    (option) => option.name === entry.residentName || option.name === entry.summary,
  );

  const allSections = recordSections("manager", "booking", { basePath });
  // A signed lease's dates belong to the Lease record, and a channel import is
  // owned by Airbnb — "Edit dates" / "Move room" become a single "Open lease" /
  // "Open listing" jump to that record instead of two dead actions.
  const openTarget = isBlock ? null : bookingOpenTarget(entry, basePath);
  // Record payment has no verified charge path on any booking yet — dropped
  // entirely rather than shown as a dead action.
  const sections = {
    ...allSections,
    headerActions: allSections.headerActions
      .filter((action) => action.id !== "record-payment")
      .filter((action) => !(openTarget && action.id === "move-room"))
      .map((action) =>
        action.id === "edit-dates" && openTarget
          ? { ...action, label: openTarget.label, icon: entry.source === "proplane" ? FileSignature : Home }
          : action,
      ),
  };

  const backHref = managerBookingListHref(basePath, "upcoming");

  const goToList = () => navigate(backHref);

  const cancelBlock = async () => {
    if (!entry.blockId) return;
    if (
      !(await confirm({
        title: "Cancel booking",
        description: `Cancel ${name || "this booking"}?`,
        confirmLabel: "Cancel booking",
        tone: "danger",
        dataAttr: "bookings-record-cancel-confirm",
      }))
    ) {
      return;
    }
    await onRemoveBlock(entry.blockId);
    goToList();
  };

  const onHeaderAction = (actionId: string) => {
    if (actionId === "edit-dates") {
      if (isBlock) setSheet("dates");
      else if (openTarget) navigate(openTarget.href);
      else showToast("Coming soon");
      return;
    }
    if (actionId === "move-room") {
      if (isBlock) setSheet("room");
      else showToast("Coming soon");
      return;
    }
    if (actionId === "cancel") {
      if (isBlock) void cancelBlock();
      else showToast("Coming soon");
      return;
    }
  };

  const ownContent =
    tab === "overview" ? (
      <div className="px-3 pb-4 sm:px-4" data-attr="booking-overview-facts">
        <Fact label="Guest" value={name} />
        <Fact label="Property" value={entry.propertyLabel} />
        <Fact label="Room" value={entry.roomLabel} />
        <Fact label="Dates" value={formatBookingStayRange(entry.start, entry.end, entry.openEnded)} />
        <Fact label="Status" value={entry.statusLabel ?? bookingSourceLabel(entry.source)} />
        <Fact label="Source" value={bookingSourceLabel(entry.source)} />
        {entry.reason ? <Fact label="Reason" value={entry.reason} /> : null}
      </div>
    ) : tab === "guest" ? (
      <div className="px-3 pb-4 sm:px-4" data-attr="booking-guest-facts">
        <Fact label="Name" value={name} />
        <Fact label="Email" value={resident?.email ?? ""} />
        {entry.reason ? <Fact label="Notes" value={entry.reason} /> : null}
      </div>
    ) : (
      <div className="px-3 pb-4 sm:px-4" data-attr="booking-charges">
        <PortalListEmptyCard
          title="No charges linked yet"
          icon={<CreditCard className="size-[22px]" strokeWidth={1.6} aria-hidden />}
          dataAttr="booking-charges-empty"
          workspaceAware={false}
        />
      </div>
    );

  return (
    <>
      <PortalRecordDetailPage
        pageTitle="Bookings"
        title={name}
        subtitle={entry.propertyLabel}
        avatarName={name}
        backHref={backHref}
        backLabel="Back to bookings"
        hideBackText
        bareHeader
        dataAttrBack="booking-detail-back"
        iconTitleActions
        pinScrollBody
      >
        <PortalRecordActions>
          <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onHeaderAction} />
        </PortalRecordActions>
        <PortalRecordSectionChrome
          sections={sections}
          recordId={bookingId}
          activeId={tab}
          title={name}
          subtitle={entry.propertyLabel}
          backHref={backHref}
          backLabel="All bookings"
          ariaLabel="Booking sections"
          onHeaderAction={onHeaderAction}
        >
          {tab === "communication" || tab === "documents" || tab === "activity"
            ? renderRecordSection(tab, {
                role: "manager",
                kind: "booking",
                kindLabel: "booking",
                recordId: bookingId,
                recordLabel: name,
                propertyId: entry.propertyId,
                contactIds: resident?.email ? [resident.email] : undefined,
              })
            : ownContent}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>

      {isBlock ? (
        <>
          <BookingsEditDatesSheet
            open={sheet === "dates"}
            onClose={() => setSheet(null)}
            entry={entry}
            entries={entries}
            onSave={async ({ checkIn, checkOut }) => {
              await onSaveBlock({
                id: entry.blockId,
                propertyId: entry.propertyId,
                roomId: entry.roomId,
                checkIn,
                checkOut,
                reason: entry.reason ?? "",
                residentName: entry.residentName ?? "",
                residentEmail: resident?.email ?? "",
              });
              showToast("Dates updated.");
            }}
          />
          <BookingsMoveRoomSheet
            open={sheet === "room"}
            onClose={() => setSheet(null)}
            entry={entry}
            entries={entries}
            onSave={async ({ roomId }) => {
              await onSaveBlock({
                id: entry.blockId,
                propertyId: entry.propertyId,
                roomId,
                checkIn: entry.start,
                checkOut: addDaysToDateKey(entry.end, 1),
                reason: entry.reason ?? "",
                residentName: entry.residentName ?? "",
                residentEmail: resident?.email ?? "",
              });
              showToast("Room updated.");
            }}
          />
        </>
      ) : null}
    </>
  );
}
