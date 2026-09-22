/**
 * Per-list group and sort definitions — the "Grouping & sort" table from
 * `PLAN-0921-1029-redesign-record-pages-services-inspections-payme`, plus the
 * pure engine that groups/sorts rows a list already has (no new fetch) and
 * the URL round-trip helpers `portal-list-controls.tsx` drives.
 *
 * Sort always applies INSIDE each group; `Group = "none"` sorts the flat
 * list. A group header is a person, a property, or a period — the same
 * shape either way: an optional avatar, a name, one sub-line, and a
 * right-hand summary that answers "what is this group worth"
 * (`portal-list-group.tsx`).
 */
import { parseMoneyAmount } from "@/lib/parse-money";
import { roomDisplayLabel } from "@/lib/room-display-label";
import {
  propertyClusterKey,
  propertyClusterLabel,
  residentClusterKey,
  residentClusterLabel,
} from "@/lib/resident-row-clustering";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";

export type PortalListGroupSortOption = { value: string; label: string };

/** Every list's group-by and sort-by menu — labels and defaults only, independent of any row shape. */
export type PortalListGroupSortCatalogEntry = {
  groupOptions: readonly PortalListGroupSortOption[];
  defaultGroup: string;
  sortOptions: readonly PortalListGroupSortOption[];
  defaultSort: string;
};

/** The value every list's "no grouping" option uses — sorts the flat list. */
export const PORTAL_LIST_GROUP_NONE = "none";

function options(...pairs: [string, string][]): PortalListGroupSortOption[] {
  return pairs.map(([value, label]) => ({ value, label }));
}

/**
 * Ship exactly the plan's table (Screens tab, "Grouping & sort"). The first
 * option in `groupOptions`/`sortOptions` is the default unless noted.
 */
export const PORTAL_LIST_GROUP_SORT_CATALOG = {
  payments: {
    groupOptions: options(
      ["resident", "Resident"],
      ["property", "Property"],
      ["month-due", "Month due"],
      ["charge-type", "Charge type"],
      [PORTAL_LIST_GROUP_NONE, "None"],
    ),
    defaultGroup: "resident",
    sortOptions: options(
      ["due-date", "Due date"],
      ["amount", "Amount"],
      ["name", "Name"],
      ["updated", "Updated"],
    ),
    defaultSort: "due-date",
  },
  services: {
    groupOptions: options(
      ["resident", "Resident"],
      ["property", "Property"],
      ["vendor", "Vendor"],
      ["type", "Type"],
      [PORTAL_LIST_GROUP_NONE, "None"],
    ),
    defaultGroup: "resident",
    sortOptions: options(["newest", "Newest"], ["oldest", "Oldest"], ["priority", "Priority"]),
    defaultSort: "newest",
  },
  tasks: {
    groupOptions: options(
      ["property", "Property"],
      ["assignee", "Assignee"],
      ["due-week", "Due week"],
      [PORTAL_LIST_GROUP_NONE, "None"],
    ),
    defaultGroup: "property",
    sortOptions: options(["due-date", "Due date"], ["created", "Created"]),
    defaultSort: "due-date",
  },
  leases: {
    groupOptions: options(
      ["property", "Property"],
      ["status", "Status"],
      ["end-month", "End month"],
      [PORTAL_LIST_GROUP_NONE, "None"],
    ),
    defaultGroup: "property",
    sortOptions: options(["start", "Start"], ["end", "End"], ["rent", "Rent"]),
    defaultSort: "start",
  },
  applications: {
    groupOptions: options(["property", "Property"], ["status", "Status"], [PORTAL_LIST_GROUP_NONE, "None"]),
    defaultGroup: "property",
    sortOptions: options(["applied", "Applied"], ["name", "Name"]),
    defaultSort: "applied",
  },
  inspections: {
    groupOptions: options(["property", "Property"], ["type", "Type"], [PORTAL_LIST_GROUP_NONE, "None"]),
    defaultGroup: "property",
    sortOptions: options(["date", "Date"], ["rooms-outstanding", "Rooms outstanding"]),
    defaultSort: "date",
  },
  tours: {
    groupOptions: options(["property", "Property"], ["day", "Day"], [PORTAL_LIST_GROUP_NONE, "None"]),
    defaultGroup: "property",
    sortOptions: options(["slot-time", "Slot time"], ["requested", "Requested"]),
    defaultSort: "slot-time",
  },
  residents: {
    groupOptions: options([PORTAL_LIST_GROUP_NONE, "None"], ["property", "Property"]),
    defaultGroup: PORTAL_LIST_GROUP_NONE,
    sortOptions: options(["name", "Name"], ["recently-updated", "Recently updated"]),
    defaultSort: "name",
  },
  vendors: {
    groupOptions: options([PORTAL_LIST_GROUP_NONE, "None"], ["trade", "Trade"]),
    defaultGroup: PORTAL_LIST_GROUP_NONE,
    sortOptions: options(["name", "Name"], ["recently-updated", "Recently updated"]),
    defaultSort: "name",
  },
  properties: {
    groupOptions: options([PORTAL_LIST_GROUP_NONE, "None"]),
    defaultGroup: PORTAL_LIST_GROUP_NONE,
    sortOptions: options(["name", "Name"], ["recently-updated", "Recently updated"]),
    defaultSort: "name",
  },
} as const satisfies Record<string, PortalListGroupSortCatalogEntry>;

export type PortalListKey = keyof typeof PORTAL_LIST_GROUP_SORT_CATALOG;

export function portalListGroupSortCatalog(listKey: PortalListKey): PortalListGroupSortCatalogEntry {
  return PORTAL_LIST_GROUP_SORT_CATALOG[listKey];
}

/** A resolved group value falls back to the list's default when it names no real option (never throws). */
export function resolvePortalListGroup(listKey: PortalListKey, value: string | null | undefined): string {
  const catalog = portalListGroupSortCatalog(listKey);
  return catalog.groupOptions.some((o) => o.value === value) ? value! : catalog.defaultGroup;
}

/** A resolved sort value falls back to the list's default when it names no real option (never throws). */
export function resolvePortalListSort(listKey: PortalListKey, value: string | null | undefined): string {
  const catalog = portalListGroupSortCatalog(listKey);
  return catalog.sortOptions.some((o) => o.value === value) ? value! : catalog.defaultSort;
}

export type PortalListGroupSummary = {
  /** The bold right-hand figure ("$3,750 due", "3 open"). Omit when a group has nothing to total. */
  figure?: string;
  /** The muted count beside the figure ("3 charges", "2 open"). */
  count: string;
  /** An optional second summary line — payments' "Paid this year", tasks' overdue count. */
  extra?: string;
};

export type PortalListGroupMeta = {
  key: string;
  name: string;
  sub?: string;
  /** Initials or a short label for a round avatar; omit for a property/period group. */
  avatar?: string;
  /**
   * Which identity the group header already names ("resident") — a row
   * rendered inside this group must not repeat it (PLAN-0921-1029 "Grouping
   * & sort": the person is already named by the header). Omitted for a
   * grouping that names something else (property, month, charge type) or no
   * grouping at all, so the row falls back to naming the resident itself,
   * since nothing else on screen does.
   */
  identity?: string;
};

export type PortalListGroupBucket<T> = PortalListGroupMeta & {
  rows: T[];
  summary: PortalListGroupSummary;
};

/**
 * Pure grouping over rows a list already has. `groupOf` returns the group a
 * row belongs to for the given (already-resolved) group value; returning
 * `null` means "no grouping" and every row lands in one flat bucket, which
 * is also what `Group = "none"` does automatically.
 */
export type PortalListGrouper<T> = {
  groupOf: (row: T, group: string) => PortalListGroupMeta | null;
  summarize: (rows: T[], group: string) => PortalListGroupSummary;
  compare: (a: T, b: T, sort: string) => number;
};

const FLAT_BUCKET_KEY = "__flat__";

/**
 * Sort within groups, then group. With `group === "none"` (or `groupOf`
 * returning `null` for every row) the whole list sorts flat as one bucket.
 * `listKey` resolves an unknown group/sort value to that list's default
 * instead of throwing.
 */
export function groupAndSortPortalListRows<T>(
  rows: readonly T[],
  listKey: PortalListKey,
  grouper: PortalListGrouper<T>,
  rawGroup: string | null | undefined,
  rawSort: string | null | undefined,
): PortalListGroupBucket<T>[] {
  const group = resolvePortalListGroup(listKey, rawGroup);
  const sort = resolvePortalListSort(listKey, rawSort);
  const sorted = [...rows].sort((a, b) => grouper.compare(a, b, sort));

  if (group === PORTAL_LIST_GROUP_NONE) {
    return [{ key: FLAT_BUCKET_KEY, name: "", rows: sorted, summary: grouper.summarize(sorted, group) }];
  }

  const order: string[] = [];
  const byKey = new Map<string, { meta: PortalListGroupMeta; rows: T[] }>();
  for (const row of sorted) {
    const meta = grouper.groupOf(row, group);
    if (!meta) {
      // The list's own data cannot place this row (e.g. no property on a
      // property grouping) — it still gets a group of its own rather than
      // disappearing or merging with a stranger.
      const key = FLAT_BUCKET_KEY;
      const existing = byKey.get(key);
      if (existing) existing.rows.push(row);
      else {
        byKey.set(key, { meta: { key, name: "" }, rows: [row] });
        order.push(key);
      }
      continue;
    }
    const existing = byKey.get(meta.key);
    if (existing) existing.rows.push(row);
    else {
      byKey.set(meta.key, { meta, rows: [row] });
      order.push(meta.key);
    }
  }

  return order.map((key) => {
    const bucket = byKey.get(key)!;
    return { ...bucket.meta, rows: bucket.rows, summary: grouper.summarize(bucket.rows, group) };
  });
}

// ---- URL + local-storage round-trip ----

export const PORTAL_LIST_GROUP_PARAM = "group";
export const PORTAL_LIST_SORT_PARAM = "sort";

export type PortalListGroupSortState = { group: string; sort: string };

/** Read `?group=&sort=` from a URL's search params, falling back to the list's defaults. */
export function readPortalListGroupSortParams(
  listKey: PortalListKey,
  searchParams: URLSearchParams | Record<string, string | string[] | undefined>,
): PortalListGroupSortState {
  const rawGroup =
    searchParams instanceof URLSearchParams
      ? searchParams.get(PORTAL_LIST_GROUP_PARAM)
      : firstSearchParamValue(searchParams[PORTAL_LIST_GROUP_PARAM]);
  const rawSort =
    searchParams instanceof URLSearchParams
      ? searchParams.get(PORTAL_LIST_SORT_PARAM)
      : firstSearchParamValue(searchParams[PORTAL_LIST_SORT_PARAM]);
  return {
    group: resolvePortalListGroup(listKey, rawGroup),
    sort: resolvePortalListSort(listKey, rawSort),
  };
}

function firstSearchParamValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** A copy of `current` with `group`/`sort` set — for building the next URL a Group/Sort menu navigates to. */
export function withPortalListGroupSortParams(
  current: URLSearchParams,
  next: Partial<PortalListGroupSortState>,
): URLSearchParams {
  const params = new URLSearchParams(current);
  if (next.group != null) params.set(PORTAL_LIST_GROUP_PARAM, next.group);
  if (next.sort != null) params.set(PORTAL_LIST_SORT_PARAM, next.sort);
  return params;
}

function portalListGroupSortStorageKey(listKey: PortalListKey): string {
  return `portal-list-group-sort:${listKey}`;
}

/** The viewer's remembered choice for this list, or `null` when there is none (or storage is unavailable). */
export function readStoredPortalListGroupSort(listKey: PortalListKey): Partial<PortalListGroupSortState> | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(portalListGroupSortStorageKey(listKey));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { group, sort } = parsed as { group?: unknown; sort?: unknown };
    return {
      group: typeof group === "string" ? group : undefined,
      sort: typeof sort === "string" ? sort : undefined,
    };
  } catch {
    return null;
  }
}

/** Remembers the viewer's choice for this list. Silently no-ops in a private window or blocked storage. */
export function writeStoredPortalListGroupSort(listKey: PortalListKey, value: PortalListGroupSortState): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(portalListGroupSortStorageKey(listKey), JSON.stringify(value));
  } catch {
    // Private mode / blocked storage — the URL stays authoritative for this load.
  }
}

// ---- Payments: the proof case (Resident grouping default ON, `pro-payments-ledger-panel.tsx`) ----

function formatWholeDollars(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    Math.round(amount),
  );
}

function paymentRowAmount(row: DemoManagerPaymentLedgerRow): number {
  return parseMoneyAmount(row.balanceDue || row.lineAmount);
}

/**
 * What a PAID row actually paid. `balanceDue` is what is still owed — a paid
 * charge's balance is `$0.00` (a non-empty, truthy string), so
 * `paymentRowAmount`'s `balanceDue || lineAmount` fallback never reaches
 * `lineAmount` for one and silently sums paid charges as $0. The charge's
 * face amount (`lineAmount`) is the one paid — same fact the row itself
 * shows (`pro-payments-ledger-panel.tsx`'s `renderAmountOwedCell`).
 */
function paidRowAmount(row: DemoManagerPaymentLedgerRow): number {
  return parseMoneyAmount(row.lineAmount);
}

function paymentRowIsOwed(row: DemoManagerPaymentLedgerRow): boolean {
  return row.bucket === "pending" || row.bucket === "overdue";
}

function paymentDueMonthLabel(row: DemoManagerPaymentLedgerRow): string {
  if (row.dueDateSortMs == null) return row.dueDate || "No due date";
  return new Date(row.dueDateSortMs).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function paymentChargeTypeLabel(row: DemoManagerPaymentLedgerRow): string {
  if (row.chargeKind) {
    return row.chargeKind
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ");
  }
  return row.chargeTitle || "Other";
}

/** Payments' concrete grouping — Resident (default) · Property · Month due · Charge type · None. */
export const PORTAL_PAYMENTS_LIST_GROUPER: PortalListGrouper<DemoManagerPaymentLedgerRow> = {
  groupOf(row, group) {
    if (group === "resident") {
      return {
        key: residentClusterKey(row),
        name: residentClusterLabel(row),
        sub: (() => {
          // The header names the person; the sub-line places them. A stored
          // room can be a raw `propertyId::roomId` key, so never print it.
          const room = roomDisplayLabel(row.roomNumber);
          if (!row.propertyName) return room || undefined;
          return room ? `${row.propertyName} · ${room}` : row.propertyName;
        })(),
        avatar: initialsFromName(residentClusterLabel(row)),
        identity: "resident",
      };
    }
    if (group === "property") {
      return {
        key: propertyClusterKey({ id: row.id, propertyId: row.propertyId, propertyLabel: row.propertyName }),
        name: propertyClusterLabel({ id: row.id, propertyLabel: row.propertyName }),
      };
    }
    if (group === "month-due") {
      const label = paymentDueMonthLabel(row);
      return { key: `month:${label}`, name: label };
    }
    if (group === "charge-type") {
      const label = paymentChargeTypeLabel(row);
      return { key: `charge-type:${label}`, name: label };
    }
    return null;
  },
  summarize(rows) {
    const owed = rows.filter(paymentRowIsOwed);
    const totalDue = owed.reduce((sum, row) => sum + paymentRowAmount(row), 0);
    const paidThisYear = rows
      .filter((row) => row.bucket === "paid" && (row.dueDateSortMs == null || isThisYear(row.dueDateSortMs)))
      .reduce((sum, row) => sum + paidRowAmount(row), 0);
    return {
      figure: owed.length ? `${formatWholeDollars(totalDue)} due` : undefined,
      count: `${owed.length} ${owed.length === 1 ? "charge" : "charges"}`,
      extra: paidThisYear > 0 ? `Paid this year · ${formatWholeDollars(paidThisYear)}` : undefined,
    };
  },
  compare(a, b, sort) {
    if (sort === "amount") return paymentRowAmount(b) - paymentRowAmount(a);
    if (sort === "name") return residentClusterLabel(a).localeCompare(residentClusterLabel(b));
    if (sort === "updated") return (dateSortValue(b.createdAt) ?? 0) - (dateSortValue(a.createdAt) ?? 0);
    // "due-date" (default): earliest due first; rows with no parsed date sort last.
    const aMs = a.dueDateSortMs ?? Number.POSITIVE_INFINITY;
    const bMs = b.dueDateSortMs ?? Number.POSITIVE_INFINITY;
    return aMs - bMs;
  },
};

function initialsFromName(name: string): string | undefined {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || undefined;
}

function isThisYear(ms: number): boolean {
  return new Date(ms).getFullYear() === new Date().getFullYear();
}

function dateSortValue(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Groups+sorts a payments list's rows per the resolved `?group=&sort=` — the Payments proof case. */
export function groupAndSortPaymentLedgerRows(
  rows: readonly DemoManagerPaymentLedgerRow[],
  rawGroup: string | null | undefined,
  rawSort: string | null | undefined,
): PortalListGroupBucket<DemoManagerPaymentLedgerRow>[] {
  return groupAndSortPortalListRows(rows, "payments", PORTAL_PAYMENTS_LIST_GROUPER, rawGroup, rawSort);
}
