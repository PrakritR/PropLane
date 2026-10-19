"use client";

import { CalendarDays, Download, Home } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatOwnerUsd, ownerMonthLabel, useOwnerFetch, withOwnerWorkspace } from "@/components/owner/owner-data";
import { OwnerError, OwnerLoading } from "@/components/owner/owner-ui";
import { useOwnerWorkspace } from "@/components/owner/owner-workspace";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { OWNER_BASE_PATH } from "@/lib/property-owner/sections";
import type { OwnerStatementHouse, OwnerStatementRow, OwnerStatements } from "@/lib/property-owner/projection";

/** The PDF address of one statement month, narrowed to a house and to the active workspace. */
export function ownerStatementPdfUrl(month: string, propertyId: string, workspaceId: string | null): string {
  const q = new URLSearchParams({ month });
  if (propertyId) q.set("propertyId", propertyId);
  return withOwnerWorkspace(`/api/owner/statements/pdf?${q.toString()}`, workspaceId);
}

/** Month rows that match a search ("oct", "2026", "october 2026"), newest first as given. */
export function filterOwnerStatementRows(rows: readonly OwnerStatementRow[], query: string): OwnerStatementRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((row) => `${ownerMonthLabel(row.month)} ${row.month}`.toLowerCase().includes(q));
}

/** Statements: one row per month, the PDF and the month's detail behind each row's menu. */
export function OwnerStatementsPage() {
  const router = useRouter();
  const workspace = useOwnerWorkspace();
  const [propertyId, setPropertyId] = useState<string>("");
  const [query, setQuery] = useState("");
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
  const rows = useMemo(() => filterOwnerStatementRows(data?.rows ?? [], query), [data, query]);
  const download = (month: string) => window.location.assign(ownerStatementPdfUrl(month, propertyId, workspace?.activeId ?? null));
  const open = (month: string) => router.push(`${OWNER_BASE_PATH}/statements/${encodeURIComponent(month)}${propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : ""}`);
  const latest = data?.rows[0]?.month ?? null;
  return (
    <div data-attr="owner-statements" className="space-y-2">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          tabs.length > 0 ? (
            <LocalDestinationNav
              items={[
                { id: "", label: "All houses", dataAttr: "owner-statements-tab-all" },
                ...tabs.map((p) => ({ id: p.propertyId, label: p.label, dataAttr: `owner-statements-tab-${p.propertyId}` })),
              ]}
              activeId={propertyId}
              onChange={setPropertyId}
              ariaLabel="Houses"
              appearance="command"
            />
          ) : undefined
        }
        activeDestinationId={propertyId}
        destinationAriaLabel="Houses"
        search={{ value: query, onChange: setQuery, placeholder: "Search statements", ariaLabel: "Search statements", dataAttr: "owner-statements-search" }}
        actions={
          latest ? (
            <PortalIconAction icon={Download} label="Download latest statement" data-attr="owner-statements-download" onClick={() => download(latest)} />
          ) : undefined
        }
      />
      {loading && !data ? (
        <OwnerLoading />
      ) : error ? (
        <OwnerError message="Couldn't load your statements." onRetry={reload} />
      ) : (
        <PortalRecordListSurface
          dataAttr="owner-statements-list"
          isEmpty={rows.length === 0}
          emptyCard={{ title: query ? "No matching statements" : "No statements yet", section: "financials" }}
        >
          {rows.map((row) => (
            <PortalPropertyRecordRow
              key={row.month}
              title={ownerMonthLabel(row.month)}
              leading={<PortalRowIconTile icon={CalendarDays} />}
              leadingShape="square"
              facts={
                <PortalRowFact icon={Home} srLabel="Houses">
                  {row.houses} {row.houses === 1 ? "house" : "houses"}
                </PortalRowFact>
              }
              amount={formatOwnerUsd(row.distributionCents)}
              amountTone={row.distributionCents < 0 ? "bad" : undefined}
              onOpen={() => open(row.month)}
              actions={
                <RowActionsMenu
                  label={`${ownerMonthLabel(row.month)} statement`}
                  items={[
                    { id: "view", label: "View", onSelect: () => open(row.month) },
                    { id: "download", label: "Download PDF", onSelect: () => download(row.month) },
                  ]}
                />
              }
              dataAttr={`owner-statement-row-${row.month}`}
            />
          ))}
        </PortalRecordListSurface>
      )}
    </div>
  );
}
