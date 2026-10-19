"use client";

import { BedDouble, Banknote, Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatOwnerUsd, useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerError } from "@/components/owner/owner-ui";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { OWNER_BASE_PATH } from "@/lib/property-owner/sections";
import type { OwnerPropertySummary, OwnerSummary } from "@/lib/property-owner/projection";

type PropertyTab = "all" | "vacancies";

/** The tabs of the list: every house, and the houses with at least one empty room. Counts come from the rows. */
export function ownerPropertyTabs(properties: readonly OwnerPropertySummary[]): { id: PropertyTab; label: string; count: number }[] {
  return [
    { id: "all", label: "All", count: properties.length },
    { id: "vacancies", label: "Vacancies", count: properties.filter((p) => p.occupied < p.units).length },
  ];
}

export function filterOwnerProperties(properties: readonly OwnerPropertySummary[], tab: PropertyTab, query: string): OwnerPropertySummary[] {
  const q = query.trim().toLowerCase();
  return properties.filter((p) => (tab === "all" || p.occupied < p.units) && (!q || p.label.toLowerCase().includes(q)));
}

export function OwnerPropertyRow({ property, onOpen }: { property: OwnerPropertySummary; onOpen: () => void }) {
  return (
    <PortalPropertyRecordRow
      title={property.label}
      leading={<PortalRowIconTile icon={Building2} />}
      leadingShape="square"
      facts={
        <>
          <PortalRowFact icon={BedDouble} srLabel="Occupied">
            {property.occupied} of {property.units} occupied
          </PortalRowFact>
          <PortalRowFact icon={Banknote} srLabel="Rent collected">
            {formatOwnerUsd(property.rentCollectedCents)} of {formatOwnerUsd(property.rentDueCents)} collected
          </PortalRowFact>
        </>
      }
      amount={formatOwnerUsd(property.netCents)}
      amountTone={property.netCents < 0 ? "bad" : undefined}
      onOpen={onOpen}
      dataAttr={`owner-property-row-${property.propertyId}`}
    />
  );
}

/** Properties: the same list surface as the manager's, read-only (no add, no edit). */
export function OwnerPropertiesList() {
  const router = useRouter();
  const { data, loading, error, reload } = useOwnerFetch<OwnerSummary>("/api/owner/summary");
  const [tab, setTab] = useState<PropertyTab>("all");
  const [query, setQuery] = useState("");
  const properties = data?.properties ?? [];
  const tabs = useMemo(() => ownerPropertyTabs(properties), [properties]);
  const rows = useMemo(() => filterOwnerProperties(properties, tab, query), [properties, tab, query]);
  const forbidden = error === "Forbidden.";
  return (
    <div data-attr="owner-properties" className="space-y-2">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          <LocalDestinationNav
            items={tabs.map((t) => ({ id: t.id, label: t.label, count: t.count, dataAttr: `owner-properties-tab-${t.id}` }))}
            activeId={tab}
            onChange={(id) => setTab(id as PropertyTab)}
            ariaLabel="Properties"
            appearance="command"
          />
        }
        activeDestinationId={tab}
        destinationAriaLabel="Properties"
        search={{ value: query, onChange: setQuery, placeholder: "Search properties", ariaLabel: "Search properties", dataAttr: "owner-properties-search" }}
      />
      {error && !forbidden ? (
        <OwnerError message="Couldn't load your properties." onRetry={reload} />
      ) : (
        <PortalRecordListSurface
          dataAttr="owner-properties-list"
          loading={loading && !data}
          isEmpty={forbidden || rows.length === 0}
          emptyCard={{ title: forbidden ? "No properties are shared with you" : query ? "No matching properties" : tab === "vacancies" ? "No vacancies" : "No properties yet", section: "properties" }}
        >
          {rows.map((p) => (
            <OwnerPropertyRow key={p.propertyId} property={p} onOpen={() => router.push(`${OWNER_BASE_PATH}/properties/${encodeURIComponent(p.propertyId)}`)} />
          ))}
        </PortalRecordListSurface>
      )}
    </div>
  );
}

