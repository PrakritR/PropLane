"use client";

import { Building2, Download, BedDouble, Banknote } from "lucide-react";
import { useRouter } from "next/navigation";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { formatOwnerUsd, ownerMonthLabel, useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerBand, OwnerError, OwnerLoading, OwnerPageTitle, OwnerTile, OwnerTiles, OwnerEmpty } from "@/components/owner/owner-ui";
import { OWNER_BASE_PATH } from "@/lib/property-owner/sections";
import type { OwnerChartPoint, OwnerPropertySummary, OwnerSummary } from "@/lib/property-owner/projection";

export function OwnerIncomeChart({ points }: { points: OwnerChartPoint[] }) {
  const max = Math.max(1, ...points.flatMap((p) => [p.incomeCents, p.expensesCents]));
  return (
    <div className="mb-4 rounded-2xl border border-border bg-card p-4" data-attr="owner-chart">
      <p className="text-sm font-semibold text-foreground">Income and expenses · last 12 months</p>
      <div className="mt-3 flex h-24 items-end gap-1.5" role="img" aria-label="Income and expenses for the last 12 months">
        {points.map((p) => (
          <div
            key={p.month}
            className="flex h-full flex-1 items-end justify-center gap-0.5"
            title={`${ownerMonthLabel(p.month)}: income ${formatOwnerUsd(p.incomeCents)} · expenses ${formatOwnerUsd(p.expensesCents)}`}
          >
            <i className="block w-1/2 rounded-t bg-primary" style={{ height: `${(p.incomeCents / max) * 100}%` }} />
            <i className="block w-1/2 rounded-t bg-muted/40" style={{ height: `${(p.expensesCents / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 text-[10px] text-muted">
        {points.map((p) => (
          <span key={p.month} className="flex-1 text-center">
            {ownerMonthLabel(p.month, true)}
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2 rounded-sm bg-primary" /> Income
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2 rounded-sm bg-muted/40" /> Expenses
        </span>
      </div>
    </div>
  );
}

export function OwnerSummaryTiles({ summary, scope }: { summary: { period: string; totals: OwnerSummary["totals"] }; scope?: OwnerPropertySummary }) {
  const t = summary.totals;
  const net = scope ? scope.netCents : t.netMonthCents;
  const ytd = scope ? scope.netYtdCents : t.netYtdCents;
  const collected = scope ? scope.rentCollectedCents : t.rentCollectedCents;
  const due = scope ? scope.rentDueCents : t.rentDueCents;
  const units = scope ? scope.units : t.units;
  const occupied = scope ? scope.occupied : t.occupied;
  return (
    <OwnerTiles>
      <OwnerTile label={`Net income · ${ownerMonthLabel(summary.period, true)}`} value={formatOwnerUsd(net)} tone={net >= 0 ? "good" : "bad"} />
      <OwnerTile label={`Net income · ${summary.period.slice(0, 4)}`} value={formatOwnerUsd(ytd)} tone={ytd >= 0 ? "good" : "bad"} />
      <OwnerTile label="Rent collected" value={formatOwnerUsd(collected)} of={`of ${formatOwnerUsd(due)}`} />
      <OwnerTile label="Occupied" value={`${occupied} of ${units}`} />
    </OwnerTiles>
  );
}

export function OwnerPropertyRow({ property, onOpen }: { property: OwnerPropertySummary; onOpen: () => void }) {
  return (
    <PortalServiceRecordRow
      title={property.label}
      useServiceTile={false}
      leading={
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
          <Building2 className="size-5" />
        </span>
      }
      facts={
        <>
          <span className="inline-flex items-center gap-1">
            <BedDouble className="size-3.5" aria-hidden /> {property.occupied} of {property.units} occupied
          </span>
          <span className="inline-flex items-center gap-1">
            <Banknote className="size-3.5" aria-hidden /> {formatOwnerUsd(property.rentCollectedCents)} of {formatOwnerUsd(property.rentDueCents)} collected
          </span>
        </>
      }
      figure={formatOwnerUsd(property.netCents)}
      onOpen={onOpen}
      dataAttr={`owner-property-row-${property.propertyId}`}
    />
  );
}

/** Screen 3: Overview. */
export function OwnerOverview() {
  const router = useRouter();
  const { data, loading, error, reload } = useOwnerFetch<OwnerSummary>("/api/owner/summary");
  // The empty state is for "no houses are shared with you". A house with rent
  // charged but nothing collected yet is real data: the tiles and the property
  // rows stay, and the chart simply draws zero bars.
  const empty = !loading && !error && data !== null && data.properties.length === 0;
  return (
    <div data-attr="owner-overview">
      <OwnerPageTitle>Overview</OwnerPageTitle>
      {loading && !data ? (
        <OwnerLoading />
      ) : error === "Forbidden." ? (
        <OwnerEmpty title="No properties are shared with you" />
      ) : error ? (
        <OwnerError message="Couldn't load your properties." onRetry={reload} />
      ) : empty || !data ? (
        <OwnerEmpty />
      ) : (
        <>
          <OwnerSummaryTiles summary={data} />
          <OwnerIncomeChart points={data.chart} />
          <OwnerBand label="Properties" count={data.properties.length}>
            <PortalIconAction
              icon={Download}
              label="Download statement"
              data-attr="owner-download-statement"
              onClick={() => router.push(`${OWNER_BASE_PATH}/statements`)}
            />
          </OwnerBand>
          <PortalRecordListSurface dataAttr="owner-properties-list">
            {data.properties.map((p) => (
              <OwnerPropertyRow key={p.propertyId} property={p} onOpen={() => router.push(`${OWNER_BASE_PATH}/properties/${encodeURIComponent(p.propertyId)}`)} />
            ))}
          </PortalRecordListSurface>
        </>
      )}
    </div>
  );
}

/** Properties tab: the same rows without the tiles. */
export function OwnerPropertiesList() {
  const router = useRouter();
  const { data, loading, error, reload } = useOwnerFetch<OwnerSummary>("/api/owner/summary");
  return (
    <div data-attr="owner-properties">
      <OwnerPageTitle>Properties</OwnerPageTitle>
      {loading && !data ? (
        <OwnerLoading />
      ) : error === "Forbidden." ? (
        <OwnerEmpty title="No properties are shared with you" />
      ) : error ? (
        <OwnerError message="Couldn't load your properties." onRetry={reload} />
      ) : !data || data.properties.length === 0 ? (
        <OwnerEmpty title="No properties yet" />
      ) : (
        <PortalRecordListSurface dataAttr="owner-properties-list">
          {data.properties.map((p) => (
            <OwnerPropertyRow key={p.propertyId} property={p} onOpen={() => router.push(`${OWNER_BASE_PATH}/properties/${encodeURIComponent(p.propertyId)}`)} />
          ))}
        </PortalRecordListSurface>
      )}
    </div>
  );
}

