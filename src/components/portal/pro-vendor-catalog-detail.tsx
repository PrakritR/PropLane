"use client";

import { axisCatalogVendorById, formatVendorCatalogUsd, type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import type { VendorDetailTabId } from "@/lib/portal-detail-routes";
import { ReviewRow, ReviewSection } from "@/components/portal/pro-application-readonly-review";

export function ManagerVendorCatalogDetail({
  catalogId,
  vendor,
  tab,
  inRoster,
}: {
  catalogId?: string;
  vendor?: AxisCatalogVendor | null;
  tab: VendorDetailTabId;
  /** Already added to this manager's own vendors — flips the Overview "Your work together" fact. */
  inRoster?: boolean;
}) {
  const row = vendor ?? axisCatalogVendorById(catalogId ?? "");
  if (!row) {
    return <div className="px-3 py-8 text-sm font-semibold" data-attr="vendor-catalog-missing">Couldn’t find that PropLane vendor.</div>;
  }
  const hourly = row.hourlyCents == null ? "—" : `${formatVendorCatalogUsd(row.hourlyCents)} / hr`;
  const typicalService = formatVendorCatalogUsd(row.serviceCents);
  return (
    <div className="pb-4 pt-3" data-attr="vendor-catalog-detail">
      {tab === "overview" ? (
        <div className="xl:columns-2 xl:gap-3 [&>*]:mb-3 [&>*]:break-inside-avoid" data-attr="vendor-catalog-overview">
          <ReviewSection title="Business">
            <ReviewRow k="Trade" v={row.trade} />
            {row.city ? <ReviewRow k="Area" v={row.city} /> : null}
            <ReviewRow k="Typical service" v={typicalService} />
            <ReviewRow k="Hourly" v={hourly} />
          </ReviewSection>
          <ReviewSection title="Contact">
            <ReviewRow k="Phone" v={row.phone} />
            <ReviewRow k="Email" v={row.email} />
          </ReviewSection>
          <ReviewSection title="About">
            <ReviewRow k="Description" v={row.description} />
          </ReviewSection>
          <ReviewSection title="Your work together">
            <ReviewRow k="Completed jobs" v="0" />
            <ReviewRow k="Ratings from your jobs" v="—" />
            <ReviewRow k="In your vendors" v={inRoster ? "Yes" : "Not yet"} />
          </ReviewSection>
        </div>
      ) : null}
      {tab === "pricing" ? (
        <div className="xl:columns-2 xl:gap-3 [&>*]:mb-3 [&>*]:break-inside-avoid" data-attr="vendor-catalog-pricing">
          <ReviewSection title="Published rates">
            <ReviewRow k="Hourly" v={hourly} />
            <ReviewRow k="Typical service" v={typicalService} />
          </ReviewSection>
          <ReviewSection title="Your completed jobs">
            <ReviewRow k="Jobs" v="0" />
            <ReviewRow k="Final invoiced" v="—" />
            <ReviewRow k="Average final invoice" v="—" />
          </ReviewSection>
        </div>
      ) : null}
      {(["jobs", "reviews", "check-ins"] as VendorDetailTabId[]).includes(tab) ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm" data-attr={`vendor-catalog-empty-${tab}`}>
          No {tab === "jobs" ? "services" : tab} are available for this catalog entry.
        </div>
      ) : null}
    </div>
  );
}
