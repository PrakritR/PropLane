"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download, Mail, Pencil } from "lucide-react";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { RecordFactCard, RecordFactRow, RecordStatTiles, StatTile } from "@/components/portal/portal-record-overview-kit";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import { BookingsEditSheet } from "@/components/portal/bookings-edit-sheet";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import type { BlockDatesDraft } from "@/components/portal/bookings-block-dates-modal";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";
import { bookingConflictsFor, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, bookingEntryKey, bookingLegacyEntryKey, bookingOpenTarget, bookingSourceLabel, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { bookingRateLabel, bookingStatusLabel, canCancelBooking } from "@/lib/channel-calendar/booking-presentation";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { bookingRecordHref, managerBookingListHref } from "@/lib/portal-detail-routes";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { usePortalNavigate } from "@/lib/portal-nav-client";

export function BookingsRecordPage({ bookingId, tab: tabProp, basePath, entries, loading, residentOptions, propertyOptions, onSaveBlock, showToast }: {
  bookingId: string; tab?: string; basePath: string; entries: readonly PropertyBookingEntry[]; loading: boolean;
  residentOptions: readonly BlockDatesResidentOption[]; propertyOptions?: readonly ManagerPropertyFilterOption[];
  onSaveBlock: (draft: BlockDatesDraft) => Promise<{ message?: string } | void>;
  onRemoveBlock: (blockId: string) => Promise<void>; showToast: (message: string) => void;
}) {
  const navigate = usePortalNavigate();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [undo, setUndo] = useState<BlockDatesDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const entry = entries.find((candidate) => bookingEntryKey(candidate) === bookingId || bookingLegacyEntryKey(candidate) === bookingId);
  useEffect(() => {
    if (entry && bookingEntryKey(entry) !== bookingId) navigate(bookingRecordHref(basePath, bookingEntryKey(entry), tabProp === "communication" ? "communication" : "overview"));
  }, [entry, bookingId, basePath, tabProp, navigate]);
  if (!entry) return <PortalDataTableEmpty icon="default" message={loading ? "Loading…" : "Booking not found."} />;
  const tab = tabProp === "communication" ? "communication" : "overview";
  const channel = entry.source === "airbnb" || entry.source === "booking_com";
  const name = entry.source === "airbnb" || entry.source === "booking_com" ? bookingGuestLabel(entry.summary, entry.source) : entry.summary;
  const resident = residentOptions.find((option) => option.email === entry.residentEmail || option.name === entry.residentName || option.name === entry.summary);
  const sourceTarget = channel ? null : bookingOpenTarget(entry, basePath);
  const backHref = managerBookingListHref(basePath, "upcoming");
  const range = formatBookingStayRange(entry.start, addDaysToDateKey(entry.end, 1), entry.openEnded);
  const nights = Math.max(1, Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / 86400000) + 1);
  const conflicts = channel ? bookingConflictsFor(entries.filter((candidate) => candidate !== entry), entry) : [];
  const sections = { ...recordSections("manager", "booking", { basePath }), headerActions: [
    ...(!channel ? [{ id: "edit", label: "Edit booking", icon: Pencil }] : []),
    { id: "message", label: "Message", icon: Mail }, { id: "download", label: "Download", icon: Download },
  ] };
  const draft = (): BlockDatesDraft => ({ id: entry.blockId, isBookingResidency: entry.isBookingResidency, openEnded: entry.openEnded, propertyId: entry.propertyId, roomId: entry.roomId, checkIn: entry.start, checkOut: addDaysToDateKey(entry.end, 1), residentName: entry.residentName ?? "", residentEmail: entry.residentEmail ?? resident?.email ?? "", residentPhone: entry.residentPhone, reason: entry.reason ?? "", bookingStatus: entry.bookingStatus ?? "hold", rate: entry.rate, rateBasis: entry.rateBasis, stayDetails: entry.stayDetails });
  const cancel = async () => { setBusy(true); setError(""); const previous = draft(); try { await onSaveBlock({ ...previous, bookingStatus: "cancelled" }); setUndo(previous); setCancelling(false); showToast("Booking cancelled."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel booking."); } finally { setBusy(false); } };
  const restore = async () => { if (!undo) return; try { await onSaveBlock(undo); setUndo(null); showToast("Booking restored."); } catch (cause) { showToast(cause instanceof Error ? cause.message : "Could not restore booking."); } };
  const onAction = (action: string) => {
    if (action === "edit") setEditing(true);
    if (action === "message") navigate(bookingRecordHref(basePath, bookingId, "communication"));
    if (action === "download") {
      const blob = new Blob([JSON.stringify({ guest: name, property: entry.propertyLabel, room: entry.roomLabel, dates: range, status: bookingStatusLabel(entry), rate: bookingRateLabel(entry), source: bookingSourceLabel(entry.source), notes: entry.reason ?? "" }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "booking.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };
  return <>
    <PortalRecordDetailPage pageTitle="Bookings" title={name} subtitle={`${entry.propertyLabel} · ${entry.roomLabel}`} avatarName={name} backHref={backHref} backLabel="Back to bookings" hideBackText bareHeader dataAttrBack="booking-detail-back" iconTitleActions pinScrollBody>
      <PortalRecordActions><PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onAction} /><BookingsRowOverflow label={name} onCancel={canCancelBooking(entry) ? () => setCancelling(true) : undefined} /></PortalRecordActions>
      <PortalRecordSectionChrome sections={sections} recordId={bookingId} activeId={tab} title={name} subtitle={entry.propertyLabel} backHref={backHref} backLabel="All bookings" ariaLabel="Booking sections" onHeaderAction={onAction}>
        {tab === "communication" ? renderRecordSection("communication", { role: "manager", kind: "booking", kindLabel: "booking", recordId: bookingId, recordLabel: name, propertyId: entry.propertyId, contactIds: (entry.residentEmail || resident?.email) ? [entry.residentEmail || resident!.email] : undefined }) : <div className="space-y-4" data-attr="booking-overview-facts">
          <RecordStatTiles><StatTile label="Dates" value={range} detail={entry.openEnded ? "Open-ended" : `${nights} ${nights === 1 ? "night" : "nights"}`} dataAttr="booking-dates" /><StatTile label="Room" value={entry.roomLabel} dataAttr="booking-room" /><StatTile label="Rate" value={bookingRateLabel(entry)} dataAttr="booking-rate" /><StatTile label="Status" value={bookingStatusLabel(entry)} dataAttr="booking-status" /></RecordStatTiles>
          <div className="grid gap-4 lg:grid-cols-2"><RecordFactCard title="Guest"><RecordFactRow label="Name" value={name} /><RecordFactRow label="Email" value={entry.residentEmail || resident?.email || "—"} /><RecordFactRow label="Phone" value={entry.residentPhone || "—"} /></RecordFactCard><RecordFactCard title="Stay"><RecordFactRow label="Property" value={entry.propertyLabel} /><RecordFactRow label="Room" value={entry.roomLabel} /><RecordFactRow label="Source" value={sourceTarget ? <Link className="text-primary" href={sourceTarget.href}>{(entry.source === "hold" ? "Application" : bookingSourceLabel(entry.source))}</Link> : entry.stayDetails?.source || (entry.source === "block" ? "Direct" : bookingSourceLabel(entry.source))} />{entry.sourceUid ? <RecordFactRow label="Calendar event" value={entry.sourceUid} /> : null}{entry.lastSyncedAt ? <RecordFactRow label="Last synced" value={new Date(entry.lastSyncedAt).toLocaleString()} /> : null}{entry.reason ? <RecordFactRow label="Notes" value={entry.reason} /> : null}{Object.entries(entry.stayDetails ?? {}).filter(([key, value]) => key !== "source" && value).map(([key, value]) => <RecordFactRow key={key} label={({ linen: "Linen", baggage: "Baggage", earlyCheckIn: "Early check-in", lateCheckOut: "Late check-out" } as Record<string, string>)[key] ?? key} value={value} />)}{conflicts.map((conflict) => <RecordFactRow key={bookingEntryKey(conflict)} label="Conflict" value={<Link className="text-danger" href={bookingRecordHref(basePath, bookingEntryKey(conflict))}>{conflict.summary} · {formatBookingStayRange(conflict.start, conflict.end, conflict.openEnded)}</Link>} />)}</RecordFactCard></div>
        </div>}
      </PortalRecordSectionChrome>
    </PortalRecordDetailPage>
    {undo ? <div role="status" className="fixed bottom-20 right-4 z-50 flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-lg">Booking cancelled<Button variant="ghost" onClick={restore}>Undo</Button></div> : null}
    {editing ? <BookingsEditSheet key={bookingEntryKey(entry)} entry={entry} entries={entries} propertyOptions={propertyOptions} onClose={() => setEditing(false)} onSave={onSaveBlock} /> : null}
    <PortalDialog open={cancelling} onClose={() => setCancelling(false)} title={`Cancel ${name}’s booking?`} tone="danger" primaryAction={{ label: "Cancel booking", onClick: cancel, disabled: busy, loading: busy }}><div className="space-y-4"><p>{entry.propertyLabel} · {entry.roomLabel}</p><p>{range}</p><label className="flex gap-2"><input type="checkbox" disabled />Notify guest (unavailable)</label>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div></PortalDialog>
  </>;
}
