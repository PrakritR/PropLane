"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

export type RecordListBandTab = { id: string; label: string; count: number; alert?: boolean };

/**
 * The standard list header band for a record's tab - one card holding the tabs with counts (blue
 * for the active one, red for an alert such as Overdue > 0), search, and the round blue + where a
 * create exists - with the rows (or the one standard empty card) UNDER it. It is a composition of
 * the same `PortalListControlStack` + `PortalRecordListSurface` the Payments page and the property
 * tabs use, not a second band. Every service-record and vendor-record list tab opens with it.
 */
export function RecordListBand({
  tabs,
  activeId,
  onChange,
  ariaLabel,
  search,
  plus,
  middle,
  isEmpty,
  emptyTitle,
  emptySection = "services",
  loading = false,
  dataAttr,
  children,
}: {
  tabs: readonly RecordListBandTab[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  search: { value: string; onChange: (value: string) => void; placeholder: string };
  /** The round blue + - omitted where nothing can be created from this tab. */
  plus?: { label: string; onClick: () => void; dataAttr?: string };
  /** Content between the band and the rows (a stage card). */
  middle?: ReactNode;
  isEmpty: boolean;
  /** The standard empty card's title, drawn UNDER the band. */
  emptyTitle: string;
  emptySection?: string;
  loading?: boolean;
  dataAttr: string;
  children: ReactNode;
}) {
  return (
    <div data-attr={dataAttr} className="pb-6">
      <PortalListControlStack
        variant="command"
        stickyDestinations={false}
        destinationRow={
          <LocalDestinationNav
            appearance="command"
            items={tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count, alert: tab.alert, dataAttr: `${dataAttr}-tab-${tab.id}` }))}
            activeId={activeId}
            onChange={onChange}
            ariaLabel={ariaLabel}
          />
        }
        search={{ ...search, dataAttr: `${dataAttr}-search`, ariaLabel: search.placeholder }}
        primary={
          plus ? <PortalPrimaryIconAction label={plus.label} icon={Plus} data-attr={plus.dataAttr ?? `${dataAttr}-plus`} onClick={plus.onClick} /> : undefined
        }
      />
      {middle}
      <PortalRecordListSurface loading={loading} isEmpty={isEmpty} emptyCard={{ title: emptyTitle, section: emptySection }}>
        {children}
      </PortalRecordListSurface>
    </div>
  );
}
