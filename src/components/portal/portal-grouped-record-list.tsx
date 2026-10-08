"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PortalListGroup } from "@/components/portal/portal-list-group";
import {
  GROUPED_LIST_PAGE_SIZE,
  groupItems,
  resolveGroupCollapsed,
  visibleGroupItems,
  type GroupedListGroup,
} from "@/lib/portal-grouped-list";

/**
 * Rows grouped under sticky, collapsible headers for a `PortalRecordListSurface`
 * list that has to hold a whole portfolio: Residents and Applications by house,
 * Vendors by trade.
 *
 * - A header is the group's name and a plain-text count (never a pill).
 * - Groups sort A to Z with the catch-all ("No house", "Other") last.
 * - A group draws its first `pageSize` rows; a row-level "Show all N" draws the
 *   rest, so a thousand residents never mount at once.
 * - Every group starts expanded; a header click collapses or reopens just that
 *   group. There is no expand-all / collapse-all control. Groups a search
 *   empties are not drawn at all.
 *
 * Pass `key` (tab, filters, sort) to reset the open/closed state when the list
 * is rebuilt around a different question.
 */
export function PortalGroupedRecordList<T>({
  items,
  groupLabel,
  groupId,
  otherLabel,
  countOf,
  itemKey,
  renderItem,
  listKey,
  searchActive = false,
  pageSize = GROUPED_LIST_PAGE_SIZE,
  countLabel,
  dataAttr,
}: {
  /** Already filtered by search, tab and filters, and already in the order each group should show. */
  items: readonly T[];
  groupLabel: (item: T) => string | null | undefined;
  groupId?: (item: T) => string | null | undefined;
  /** "No house" / "Other". */
  otherLabel: string;
  /** Records an item stands for, when one item is a cluster of several. */
  countOf?: (item: T) => number;
  itemKey: (item: T) => string;
  renderItem: (item: T, group: GroupedListGroup<T>) => ReactNode;
  /** Scopes `data-attr`s and test ids ("residents", "vendors"). */
  listKey: string;
  /** A non-empty search box: opens every group and drops the empty ones. */
  searchActive?: boolean;
  pageSize?: number;
  /** The header's count text; defaults to the bare number. */
  countLabel?: (count: number) => string;
  dataAttr?: string;
}) {
  const groups = useMemo(
    () => groupItems(items, { groupLabel, groupId, otherLabel, countOf }),
    [items, groupLabel, groupId, otherLabel, countOf],
  );
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});

  // Starting a search forgets earlier clicks, so every match is on screen.
  const wasSearching = useRef(searchActive);
  useEffect(() => {
    if (searchActive && !wasSearching.current) {
      setOverride({});
    }
    wasSearching.current = searchActive;
  }, [searchActive]);

  const collapsedOf = (group: GroupedListGroup<T>) =>
    resolveGroupCollapsed({ override: override[group.key], searchActive });

  return (
    <div data-attr={dataAttr ?? `${listKey}-grouped-list`} data-group-count={groups.length}>
      {groups.map((group) => {
        const collapsed = collapsedOf(group);
        const expandedAll = showAll[group.key] === true;
        const { items: shown, hidden } = visibleGroupItems(group, expandedAll, pageSize);
        return (
          <PortalListGroup
            key={group.key}
            listKey={listKey}
            groupKey={group.key}
            name={group.label}
            count={countLabel ? countLabel(group.count) : String(group.count)}
            collapsed={collapsed}
            onCollapsedChange={(next) => setOverride((prev) => ({ ...prev, [group.key]: next }))}
            dataAttr={`${listKey}-group`}
          >
            {collapsed ? null : (
              <>
                {shown.map((item) => (
                  <Fragment key={itemKey(item)}>{renderItem(item, group)}</Fragment>
                ))}
                {hidden > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowAll((prev) => ({ ...prev, [group.key]: true }))}
                    data-attr={`${listKey}-group-show-all`}
                    className="flex h-11 w-full items-center px-[22px] text-left text-[13px] font-medium text-primary transition-colors hover:bg-secondary max-lg:px-4"
                  >
                    Show all {group.items.length}
                  </button>
                ) : expandedAll && group.items.length > pageSize ? (
                  <button
                    type="button"
                    onClick={() => setShowAll((prev) => ({ ...prev, [group.key]: false }))}
                    data-attr={`${listKey}-group-show-fewer`}
                    className="flex h-11 w-full items-center px-[22px] text-left text-[13px] font-medium text-primary transition-colors hover:bg-secondary max-lg:px-4"
                  >
                    Show fewer
                  </button>
                ) : null}
              </>
            )}
          </PortalListGroup>
        );
      })}
    </div>
  );
}
