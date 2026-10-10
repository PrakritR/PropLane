"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ExternalLink, Pencil, UserRound } from "lucide-react";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { RecordFactCard, RecordFactRow, RecordRowsCard, type RecordRowItem } from "@/components/portal/portal-record-overview-kit";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { BookingsGuestNameDialog } from "@/components/portal/bookings-guest-name-dialog";
import { BookingsCancelDialog } from "@/components/portal/bookings-cancel-dialog";
import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import { BookingsRemoveStayDialog } from "@/components/portal/bookings-remove-stay-dialog";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import type { BlockDatesDraft } from "@/components/portal/bookings-block-dates-modal";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";
import type { StayMeta } from "@/lib/channel-calendar/stay-meta";
import { bookingConflictsFor, isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingDatesLabel, bookingEntryKey, bookingLegacyEntryKey, bookingOpenTarget, bookingPlaceLine, bookingResidentHref, bookingSourceLabel, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { bookingCancelLabel, bookingRateLabel, bookingStatusLabel, canCancelBooking, canRemoveChannelStay } from "@/lib/channel-calendar/booking-presentation";
import { airbnbLinkForRoom, channelCheckFacts, type ChannelRoomLink } from "@/lib/channel-calendar/channel-links";
import { bookingEntryGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { bookingRecordHref, managerBookingListHref, parseBookingDetailTab, paymentRecordDetailHref } from "@/lib/portal-detail-routes";
import { bookingCharges, bookingMoney, bookingNights, bookingOverdueTotal, bookingRateSummary, guestPastStays } from "@/lib/channel-calendar/booking-record";
import { readHouseholdCharges } from "@/lib/household-charges";
import { dateKey } from "@/lib/room-availability-calendar";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { usePortalNavigate } from "@/lib/portal-nav-client";

export function BookingsRecordPage({ bookingId, tab: tabProp, basePath, entries, loading, residentOptions, propertyOptions, onSaveBlock, onSaveStayMeta, showToast, onRefresh, channelLinks = [] }: {
  bookingId: string; tab?: string; basePath: string; entries: readonly PropertyBookingEntry[]; loading: boolean;
  residentOptions: readonly BlockDatesResidentOption[]; propertyOptions?: readonly ManagerPropertyFilterOption[];
  onSaveBlock: (draft: BlockDatesDraft) => Promise<{ message?: string } | void>;
  onSaveStayMeta?: (meta: StayMeta) => Promise<unknown>;
  onRemoveBlock: (blockId: string) => Promise<void>; showToast: (message: string) => void;
  /** Reload the bookings after a change made outside the block store (a removed channel stay). */
  onRefresh?: () => void;
  /** Rooms linked to a channel - the record says when each side last checked the other. */
  channelLinks?: readonly ChannelRoomLink[];
}) {
  const navigate = usePortalNavigate();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [namingGuest, setNamingGuest] = useState(false);
  const [removingStay, setRemovingStay] = useState<PropertyBookingEntry | null>(null);
  const entry = entries.find((candidate) => bookingEntryKey(candidate) === bookingId || bookingLegacyEntryKey(candidate) === bookingId);
  useEffect(() => {
    if (entry && bookingEntryKey(entry) !== bookingId) navigate(bookingRecordHref(basePath, bookingEntryKey(entry), parseBookingDetailTab(tabProp)));
  }, [entry, bookingId, basePath, tabProp, navigate]);
  const removeStayDialog = removingStay ? <BookingsRemoveStayDialog key={bookingEntryKey(removingStay)} entry={removingStay} onClose={() => setRemovingStay(null)} onChanged={() => onRefresh?.()} /> : null;
  if (!entry) return <>{removeStayDialog}<PortalDataTableEmpty icon="default" message={loading ? "Loading…" : "Booking not found."} /></>;
  const tab = parseBookingDetailTab(tabProp);
  const channel = isChannelBookingSource(entry.source);
  const name = bookingEntryGuestLabel(entry);
  // An Airbnb stay carries its own reservation code and feed id; the manager can name the guest and open it in Airbnb.
  const airbnbStay = entry.source === "airbnb" && !isHostBlockSummary(entry.summary) && Boolean(entry.connectionId && entry.sourceUid);
  const airbnbUrl = airbnbStay && entry.reservationUrl?.startsWith("https://www.airbnb.com/hosting/reservations/details/") ? entry.reservationUrl : null;
  const resident = residentOptions.find((option) => option.email === entry.residentEmail || option.name === entry.residentName || option.name === entry.summary);
  const guestEmail = entry.residentEmail || resident?.email || "";
  const sourceTarget = channel ? null : bookingOpenTarget(entry, basePath);
  const backHref = managerBookingListHref(basePath, "upcoming");
  const range = bookingDatesLabel(entry);
  const nights = bookingNights(entry);
  const conflicts = channel ? bookingConflictsFor(entries.filter((candidate) => candidate !== entry), entry) : [];
  const today = dateKey(new Date());
  const base = recordSections("manager", "booking", { basePath });
  const residentHref = bookingResidentHref(entry, basePath, today);
  const headerActions = base.headerActions.filter((action) => action.id !== "edit" || !channel);
  const sections = {
    ...base,
    headerActions: residentHref ? [...headerActions, { id: "open-resident", label: "Open resident", icon: UserRound }] : headerActions,
  };
  const onAction = (action: string) => {
    if (action === "edit") setEditing(true);
    if (action === "open-resident" && residentHref) navigate(residentHref);
    if (action === "message") navigate(bookingRecordHref(basePath, bookingId, "communication"));
  };
  const place = bookingPlaceLine(entry.propertyLabel, entry.roomLabel);
  const channelLabel = channel ? [bookingSourceLabel(entry.source), entry.sourceUid].filter(Boolean).join(" · ") : sourceTarget ? "" : entry.stayDetails?.source || (entry.source === "block" ? "Direct" : bookingSourceLabel(entry.source));
  const stayDetailRows = Object.entries(entry.stayDetails ?? {}).filter(([key, value]) => key !== "source" && value);
  const checkTimes = [entry.stayDetails?.earlyCheckIn && `Check-in ${entry.stayDetails.earlyCheckIn}`, entry.stayDetails?.lateCheckOut && `Check-out ${entry.stayDetails.lateCheckOut}`].filter(Boolean).join(" · ");
  const status = bookingStatusLabel(entry);
  const airbnbLink = airbnbLinkForRoom(channelLinks, entry.propertyId, entry.roomId);

  let body: ReactNode;
  if (tab === "communication") {
    body = renderRecordSection("communication", { role: "manager", kind: "booking", kindLabel: "booking", recordId: bookingId, recordLabel: name, propertyId: entry.propertyId, contactIds: guestEmail ? [guestEmail] : undefined });
  } else if (tab === "guest") {
    const past = guestPastStays(entry, entries, today);
    body = (
      <RecordFactCard title="Guest" dataAttr="booking-guest-card">
        <RecordFactRow label="Name" value={airbnbStay ? <span className="flex items-center gap-1.5">{name}<PortalIconAction icon={Pencil} label="Edit name" onClick={() => setNamingGuest(true)} data-attr="booking-guest-name-edit" /></span> : name} />
        {airbnbStay && entry.reservationCode ? <RecordFactRow label="Reservation" value={<span className="flex items-center gap-1.5">{entry.reservationCode}{airbnbUrl ? <PortalIconAction icon={ExternalLink} label="Open in Airbnb" onClick={() => window.open(airbnbUrl, "_blank", "noopener,noreferrer")} data-attr="booking-open-in-airbnb" /> : null}</span>} /> : null}
        {entry.phoneLast4 ? <RecordFactRow label="Phone ending" value={entry.phoneLast4} /> : null}
        <RecordFactRow label="Email" value={guestEmail || "—"} />
        <RecordFactRow label="Phone" value={entry.residentPhone || "—"} />
        <RecordFactRow label="Past stays" value={past.count === 0 ? "None yet" : `${past.count} · ${past.latest ? `last ${formatBookingStayRange(past.latest.start, past.latest.end)}` : ""}`} />
      </RecordFactCard>
    );
  } else if (tab === "payments") {
    const summary = bookingRateSummary(entry);
    const charges = bookingCharges(entry, readHouseholdCharges());
    const overdue = bookingOverdueTotal(charges);
    const rows: RecordRowItem[] = [
      ...(charges.length > 0 ? [{ id: "overdue", title: "Overdue", sub: overdue > 0 ? "Past due" : "Nothing past due", figure: bookingMoney(overdue) }] : []),
      ...(summary ? [{ id: "stay", title: summary.total ? "Stay total" : "Rate", sub: summary.calc, figure: summary.total ?? bookingRateLabel(entry) }] : [{ id: "rate", title: "Rate", sub: `${nights} ${nights === 1 ? "night" : "nights"}`, figure: bookingRateLabel(entry) }]),
      ...charges.map((charge) => ({
        id: charge.id,
        title: charge.title,
        sub: charge.status === "paid" ? "Paid" : charge.status === "cancelled" ? "Cancelled" : "To pay",
        figure: charge.amountLabel,
        href: paymentRecordDetailHref(basePath, "incoming", charge.status === "paid" ? "paid" : "pending", charge.id),
      })),
    ];
    body = <RecordRowsCard title="Payments" rows={rows} dataAttr="booking-payments-card" />;
  } else {
    body = (
      <RecordFactCard title="Booking" dataAttr="booking-overview-facts">
        <RecordFactRow label="Dates" value={`${range}${entry.openEnded ? " · open-ended" : ` · ${nights} ${nights === 1 ? "night" : "nights"}`}`} />
        <RecordFactRow label="Where" value={place} />
        {channelLabel ? <RecordFactRow label="Channel" value={channelLabel} /> : null}
        {sourceTarget ? <RecordFactRow label="Source" value={<Link className="text-primary" href={sourceTarget.href}>{entry.source === "hold" ? (entry.applicationId ? "Resident" : "Application") : bookingSourceLabel(entry.source)}</Link>} /> : null}
        {checkTimes ? <RecordFactRow label="Check-in / out" value={checkTimes} /> : null}
        <RecordFactRow label="Status" value={status} />
        {entry.monthlyRent != null ? <RecordFactRow label="Rent" value={bookingRateLabel(entry)} /> : <RecordFactRow label="Rate" value={bookingRateLabel(entry)} />}
        {entry.securityDeposit != null ? <RecordFactRow label="Deposit" value={bookingMoney(entry.securityDeposit)} /> : null}
        {entry.leaseTerm ? <RecordFactRow label="Lease term" value={entry.leaseTerm} /> : null}
        {entry.lastSyncedAt ? <RecordFactRow label="Last synced" value={new Date(entry.lastSyncedAt).toLocaleString()} /> : null}
        {airbnbLink ? channelCheckFacts(airbnbLink).map((fact) => <RecordFactRow key={fact.label} label={fact.label} value={fact.value} />) : null}
        {entry.reason ? <RecordFactRow label="Notes" value={entry.reason} /> : null}
        {stayDetailRows.filter(([key]) => key !== "earlyCheckIn" && key !== "lateCheckOut").map(([key, value]) => <RecordFactRow key={key} label={({ linen: "Linen", baggage: "Baggage" } as Record<string, string>)[key] ?? key} value={value} />)}
        {conflicts.map((conflict) => <RecordFactRow key={bookingEntryKey(conflict)} label="Conflict" value={<Link className="text-danger" href={bookingRecordHref(basePath, bookingEntryKey(conflict))}>{conflict.summary} · {formatBookingStayRange(conflict.start, conflict.end, conflict.openEnded)}</Link>} />)}
      </RecordFactCard>
    );
  }
  return <>
    <PortalRecordDetailPage pageTitle="Bookings" title={name} subtitle={place} avatarName={name} backHref={backHref} backLabel="Back to bookings" hideBackText bareHeader dataAttrBack="booking-detail-back" iconTitleActions pinScrollBody>
      <PortalRecordActions><PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onAction} primaryId="message" /><BookingsRowOverflow label={name} onCancel={canCancelBooking(entry) ? () => setCancelling(true) : canRemoveChannelStay(entry) ? () => setRemovingStay(entry) : undefined} cancelLabel={canRemoveChannelStay(entry) ? "Remove stay" : bookingCancelLabel(entry)} /></PortalRecordActions>
      <PortalRecordSectionChrome sections={sections} recordId={bookingId} activeId={tab} title={name} subtitle={entry.propertyLabel} backHref={backHref} backLabel="All bookings" ariaLabel="Booking sections" onHeaderAction={onAction}>
        {body}
      </PortalRecordSectionChrome>
    </PortalRecordDetailPage>
    {removeStayDialog}
    {namingGuest ? <BookingsGuestNameDialog key={bookingEntryKey(entry)} entry={entry} onClose={() => setNamingGuest(false)} onSaved={() => { showToast("Guest name saved"); onRefresh?.(); }} /> : null}
    {editing ? <BookingsEditSheet key={bookingEntryKey(entry)} entry={entry} entries={entries} propertyOptions={propertyOptions} onClose={() => setEditing(false)} onSave={onSaveBlock} onSaveStayMeta={onSaveStayMeta} /> : null}
    {cancelling ? <BookingsCancelDialog key={bookingEntryKey(entry)} entry={{ ...entry, residentEmail: entry.residentEmail || resident?.email }} onClose={() => setCancelling(false)} onSave={onSaveBlock} /> : null}
  </>;
}
