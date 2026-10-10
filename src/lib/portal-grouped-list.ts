/**
 * The pure half of `PortalGroupedRecordList` — how a long manager list (100
 * houses, thousands of residents, hundreds of vendors) is bucketed, ordered and
 * trimmed before anything is drawn. No React here, so the order, the counts and
 * the "Show all" arithmetic are testable against a synthetic portfolio.
 *
 * A group is a house (Residents, Applications) or a trade (Vendors). Groups sort
 * A to Z with the numeric-aware collator (so "House 2" sits before "House 10"),
 * and the catch-all bucket ("No house", "Other") is always last. Items keep the
 * order the caller gave them inside each group: the caller sorts, this only
 * buckets.
 */

/** Rows a group draws before "Show all N" takes over. */
export const GROUPED_LIST_PAGE_SIZE = 25;

export type GroupedListGroup<T> = {
  /** Stable id for collapsed / show-all state. `"__other__"` for the catch-all bucket. */
  key: string;
  /** What the sticky header says. */
  label: string;
  items: T[];
  /** What the header counts: `countOf` summed over the items (one each by default). */
  count: number;
  /** The catch-all bucket (no house, no trade) — always sorted last. */
  other: boolean;
};

export const GROUPED_LIST_OTHER_KEY = "__other__";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function normalizeGroupLabel(label: string | null | undefined): string {
  return (label ?? "").replace(/\s+/g, " ").trim();
}

export type GroupItemsOptions<T> = {
  /** The group the item belongs to. Blank or null drops it in the catch-all bucket. */
  groupLabel: (item: T) => string | null | undefined;
  /** Distinguishes two groups that share a label (two houses called "Maple"). Defaults to the label. */
  groupId?: (item: T) => string | null | undefined;
  /** What the catch-all bucket is called ("No house", "Other"). */
  otherLabel: string;
  /** How many records an item stands for (a household cluster of 3 applications is 3). Defaults to 1. */
  countOf?: (item: T) => number;
};

/** Buckets `items` under their group, groups A to Z with the catch-all last. */
export function groupItems<T>(items: readonly T[], options: GroupItemsOptions<T>): GroupedListGroup<T>[] {
  const otherNormalized = normalizeGroupLabel(options.otherLabel).toLowerCase();
  const byKey = new Map<string, GroupedListGroup<T>>();
  for (const item of items) {
    const label = normalizeGroupLabel(options.groupLabel(item));
    const isOther = !label || label.toLowerCase() === otherNormalized;
    const id = isOther ? "" : normalizeGroupLabel(options.groupId?.(item)) || label.toLowerCase();
    const key = isOther ? GROUPED_LIST_OTHER_KEY : id;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: isOther ? options.otherLabel : label, items: [], count: 0, other: isOther };
      byKey.set(key, group);
    }
    group.items.push(item);
    group.count += options.countOf ? options.countOf(item) : 1;
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.other !== b.other) return a.other ? 1 : -1;
    const byLabel = collator.compare(a.label, b.label);
    return byLabel !== 0 ? byLabel : collator.compare(a.key, b.key);
  });
}

/** The items a group draws now, and how many "Show all" would add. */
export function visibleGroupItems<T>(
  group: Pick<GroupedListGroup<T>, "items">,
  showAll: boolean,
  pageSize: number = GROUPED_LIST_PAGE_SIZE,
): { items: T[]; hidden: number } {
  if (showAll || group.items.length <= pageSize) return { items: group.items, hidden: 0 };
  return { items: group.items.slice(0, pageSize), hidden: group.items.length - pageSize };
}

/**
 * Most groups a list may start fully expanded. There is no Expand all / Collapse
 * all control, so a portfolio with more groups than this opens collapsed except
 * its first group; a header click or a search opens the rest.
 */
export const GROUPED_LIST_AUTO_EXPAND_MAX_GROUPS = 20;

/**
 * Whether a group is collapsed. A click (`override`) always wins. Otherwise a
 * search opens every group that still has a match, and with no search the
 * groups start expanded when there are at most
 * `GROUPED_LIST_AUTO_EXPAND_MAX_GROUPS` of them; above that every group starts
 * collapsed except the first (`groupIndex` 0).
 *
 * Cost: an expanded group mounts its first page of rows (`GROUPED_LIST_PAGE_SIZE`),
 * so the worst start is 20 groups x 25 rows = 500 mounted rows, and the
 * threshold is what keeps a 100-house portfolio from mounting 2,500. "Show all"
 * can still add every row of one group, so a single huge group is not capped.
 */
export function resolveGroupCollapsed(args: {
  override: boolean | undefined;
  searchActive: boolean;
  groupCount: number;
  groupIndex: number;
}): boolean {
  if (args.override !== undefined) return args.override;
  if (args.searchActive) return false;
  if (args.groupCount <= GROUPED_LIST_AUTO_EXPAND_MAX_GROUPS) return false;
  return args.groupIndex !== 0;
}

/** The sort the Residents and Applications Filter popovers offer (House is the default). */
export type HouseListSort = "house" | "name" | "recent";

export const HOUSE_LIST_SORT_OPTIONS: readonly { value: HouseListSort; label: string }[] = [
  { value: "house", label: "House" },
  { value: "name", label: "Name" },
  { value: "recent", label: "Recently updated" },
];

export const HOUSE_LIST_DEFAULT_SORT: HouseListSort = "house";

export function houseListSortActiveCount(sort: HouseListSort): number {
  return sort === HOUSE_LIST_DEFAULT_SORT ? 0 : 1;
}

/** A to Z, numeric-aware, case and accent blind: the one name order every grouped list uses. */
export function compareGroupedLabels(a: string | null | undefined, b: string | null | undefined): number {
  return collator.compare(a ?? "", b ?? "");
}

/**
 * Orders `items` for a House / Name / Recently-updated sort. House keeps the
 * grouping to the caller (it still sorts A to Z by name inside the group, which
 * is what `byName` gives); Recently updated is newest first with name as the
 * tie-break so equal stamps do not shuffle between renders.
 */
export function sortHouseListItems<T>(
  items: readonly T[],
  sort: HouseListSort,
  accessors: { name: (item: T) => string; updatedMs: (item: T) => number; tieBreak?: (item: T) => string },
): T[] {
  const byName = (a: T, b: T) =>
    compareGroupedLabels(accessors.name(a), accessors.name(b)) ||
    compareGroupedLabels(accessors.tieBreak?.(a), accessors.tieBreak?.(b));
  const copy = [...items];
  if (sort === "recent") {
    return copy.sort((a, b) => accessors.updatedMs(b) - accessors.updatedMs(a) || byName(a, b));
  }
  return copy.sort(byName);
}
