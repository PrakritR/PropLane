"use client";

import { CalendarDays, Download, Home } from "lucide-react";
import { useState } from "react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { formatOwnerUsd, ownerMonthLabel, useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerBand, OwnerEmpty, OwnerError, OwnerLoading, OwnerPageTitle } from "@/components/owner/owner-ui";
import type { OwnerStatementHouse, OwnerStatements } from "@/lib/property-owner/projection";
import { cn } from "@/lib/utils";

/** Screen 5: Statements — one row per month, the PDF behind a Download icon. */
export function OwnerStatementsPage() {
  const [propertyId, setPropertyId] = useState<string>("");
  // The whole-portfolio response is both the "All houses" rows and the tab list:
  // the houses come from the STATEMENTS grant, so a house granted Performance
  // but not Statements never shows a tab that 404s, and an owner with
  // Statements and no Performance still gets a per-house filter.
  const all = useOwnerFetch<OwnerStatements>("/api/owner/statements");
  const filtered = useOwnerFetch<OwnerStatements>(
    propertyId ? `/api/owner/statements?propertyId=${encodeURIComponent(propertyId)}` : null,
  );
  const { data, loading, error, reload } = propertyId ? filtered : all;
  const tabs: OwnerStatementHouse[] = all.data?.houses ?? [];
  const download = (month: string) => {
    const q = new URLSearchParams({ month });
    if (propertyId) q.set("propertyId", propertyId);
    window.location.assign(`/api/owner/statements/pdf?${q.toString()}`);
  };
  return (
    <div data-attr="owner-statements">
      <OwnerPageTitle>Statements</OwnerPageTitle>
      {tabs.length > 0 ? (
        <OwnerBand label="">
          <span className="mr-auto flex flex-wrap gap-1" role="tablist" aria-label="Houses">
            <button
              type="button"
              role="tab"
              aria-selected={propertyId === ""}
              onClick={() => setPropertyId("")}
              className={cn("rounded-md px-2 py-1 text-sm font-semibold", propertyId === "" ? "bg-accent text-foreground" : "text-muted")}
            >
              All houses
            </button>
            {tabs.map((p) => (
              <button
                key={p.propertyId}
                type="button"
                role="tab"
                aria-selected={propertyId === p.propertyId}
                onClick={() => setPropertyId(p.propertyId)}
                className={cn("rounded-md px-2 py-1 text-sm font-semibold", propertyId === p.propertyId ? "bg-accent text-foreground" : "text-muted")}
              >
                {p.label}
              </button>
            ))}
          </span>
        </OwnerBand>
      ) : null}
      {loading && !data ? (
        <OwnerLoading />
      ) : error ? (
        <OwnerError message="Couldn't load your statements." onRetry={reload} />
      ) : !data || data.rows.length === 0 ? (
        <OwnerEmpty title="No statements yet" />
      ) : (
        <PortalRecordListSurface dataAttr="owner-statements-list">
          {data.rows.map((row) => (
            <PortalServiceRecordRow
              key={row.month}
              title={ownerMonthLabel(row.month)}
              useServiceTile={false}
              leading={
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
                  <CalendarDays className="size-5" />
                </span>
              }
              facts={
                <span className="inline-flex items-center gap-1">
                  <Home className="size-3.5" aria-hidden /> {row.houses} {row.houses === 1 ? "house" : "houses"}
                </span>
              }
              figure={formatOwnerUsd(row.distributionCents)}
              onOpen={() => download(row.month)}
              actions={<PortalIconAction icon={Download} label="Download" data-attr={`owner-statement-download-${row.month}`} onClick={() => download(row.month)} />}
              dataAttr={`owner-statement-row-${row.month}`}
            />
          ))}
        </PortalRecordListSurface>
      )}
    </div>
  );
}
