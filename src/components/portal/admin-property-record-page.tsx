"use client";

import { useMemo } from "react";
import { Eye, ListChecks, XCircle } from "lucide-react";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordFactCard, RecordFactRow, RecordRowsCard } from "@/components/portal/portal-record-overview-kit";
import {
  adminPropertyRentDisplayLabel,
  publicListingHrefForPropertyRow,
  type AdminPropertyRow,
} from "@/lib/demo-admin-property-inventory";

/**
 * Admin Properties' row-opens-record page (C163): a row used to be a dead
 * click (checkbox-select only) with View/Unlist promoted to a bulk-action
 * bar. Same two actions, now header icons on a real record page — no edit,
 * because the listing belongs to the manager who wrote it
 * ("Admin borrows; it does not invent").
 */
export function AdminPropertyRecordPage({
  row,
  backHref,
  activeKpi,
  onList,
  onUnlist,
  busy,
}: {
  row: AdminPropertyRow;
  backHref: string;
  activeKpi: 2 | 3;
  onList: () => void;
  onUnlist: () => void;
  busy: boolean;
}) {
  const rooms = useMemo(() => row.submission?.rooms ?? [], [row.submission]);
  const publicHref = publicListingHrefForPropertyRow(row);
  const isListed = activeKpi === 2;

  return (
    <PortalRecordDetailPage
      title={`${row.buildingName} · ${row.unitLabel}`}
      subtitle={`${row.address}${row.zip ? `, ${row.zip}` : ""}`}
      avatarName={row.buildingName}
      backHref={backHref}
      backLabel="Properties"
      iconTitleActions
      actions={
        <PortalRecordActions>
          {publicHref ? (
            <PortalIconAction
              ring
              icon={Eye}
              label="View public listing"
              data-attr="admin-property-view-listing"
              onClick={() => window.open(publicHref, "_blank", "noopener")}
            />
          ) : null}
          {isListed && row.listingId ? (
            <PortalIconAction
              ring
              ringPrimary={!publicHref}
              tone="danger"
              icon={XCircle}
              label="Unlist"
              disabled={busy}
              data-attr="admin-property-unlist"
              onClick={onUnlist}
            />
          ) : null}
          {!isListed ? (
            <PortalIconAction
              ring
              ringPrimary={!publicHref}
              icon={ListChecks}
              label="List"
              disabled={busy}
              data-attr="admin-property-list"
              onClick={onList}
            />
          ) : null}
        </PortalRecordActions>
      }
    >
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
        <RecordFactCard title="Overview" dataAttr="admin-property-overview">
          <RecordFactRow label="Rent" value={adminPropertyRentDisplayLabel(row)} />
          <RecordFactRow label="Beds / baths" value={`${row.beds} bd / ${row.baths} ba`} />
          <RecordFactRow label="Neighborhood" value={row.neighborhood || "—"} />
          <RecordFactRow label="Pet friendly" value={row.petFriendly ? "Yes" : "No"} />
          <RecordFactRow label="Status" value={isListed ? "Listed" : "Unlisted"} />
          {row.tagline ? <RecordFactRow label="Tagline" value={row.tagline} /> : null}
        </RecordFactCard>

        <RecordRowsCard
          title="Rooms"
          dataAttr="admin-property-rooms"
          emptyLabel="No individually listed rooms on this property."
          rows={rooms.map((r) => ({
            id: r.id,
            title: r.name || "Room",
            sub: r.floor ? `Floor ${r.floor}` : undefined,
            figure: r.monthlyRent ? `$${r.monthlyRent.toLocaleString()}/mo` : undefined,
          }))}
        />
      </div>
    </PortalRecordDetailPage>
  );
}
