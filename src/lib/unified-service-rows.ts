/**
 * One "Services" list over two stores.
 *
 * A manager, and a resident, think about one pile of work: something needs doing at the property.
 * PropLane keeps that in two places — add-on services a resident BUYS (parking, storage) in
 * `portal_service_request_records`, and maintenance a resident REPORTS in
 * `portal_work_order_records`. Those models genuinely differ (one has a price, a deposit and a
 * return date; the other has a priority, an arrival window and entry permission), and AGENTS.md is
 * explicit that their tables and counts must not be merged.
 *
 * So this merges the PRESENTATION and nothing else. It reads rows that are already loaded and
 * projects them onto one shape for a single list. Every row keeps its `kind` and its own id, so
 * opening one still routes into the right detail surface and writes still go to the right store.
 * Nothing here reads or writes storage.
 */

/** Which store a row came from. Carried on every row so a click can route back correctly. */
export type ServiceRowKind = "add-on" | "maintenance";

/** Coarse state shared by both models, for one set of filter pills over the merged list. */
export type ServiceRowState = "open" | "scheduled" | "done" | "declined";

export type UnifiedServiceRow = {
  id: string;
  kind: ServiceRowKind;
  title: string;
  /** The model's own wording — "Pending", "Open", "Approved" — shown as-is. */
  statusLabel: string;
  state: ServiceRowState;
  residentName: string;
  residentEmail: string;
  propertyLabel: string;
  unitLabel: string;
  /** ISO of when this is scheduled to happen, when the model knows. */
  scheduledIso: string;
  /** ISO the row was created, used for ordering when nothing is scheduled. */
  createdIso: string;
};

/**
 * Map an add-on request's status onto the shared state.
 *
 * `returned` counts as done: the item came back, the request is finished. `denied` is its own
 * state rather than done, because a manager filtering for finished work should not be shown
 * things that never happened.
 */
export function addOnState(status: string | undefined | null): ServiceRowState {
  switch ((status ?? "").toLowerCase()) {
    case "approved":
      return "scheduled";
    case "returned":
      return "done";
    case "denied":
      return "declined";
    default:
      return "open";
  }
}

/**
 * Map a work order's bucket onto the shared state.
 *
 * Unknown buckets read as `open` — the state that keeps a row VISIBLE in the default filter.
 * Guessing `done` would hide real work behind a filter nobody thinks to change.
 */
export function maintenanceState(bucket: string | undefined | null): ServiceRowState {
  switch ((bucket ?? "").toLowerCase()) {
    case "scheduled":
      return "scheduled";
    case "completed":
      return "done";
    case "cancelled":
    case "declined":
      return "declined";
    default:
      return "open";
  }
}

type AddOnInput = {
  id: string;
  offerName?: string | null;
  status?: string | null;
  residentName?: string | null;
  residentEmail?: string | null;
  propertyId?: string | null;
  requestedAt?: string | null;
  approvedAt?: string | null;
};

type MaintenanceInput = {
  id: string;
  title?: string | null;
  status?: string | null;
  bucket?: string | null;
  residentName?: string | null;
  residentEmail?: string | null;
  propertyName?: string | null;
  unit?: string | null;
  scheduledAtIso?: string | null;
  createdAtIso?: string | null;
};

/**
 * Project both stores onto one list, newest-relevant first.
 *
 * `propertyLabelForRequest` is passed in because an add-on request stores only a property ID —
 * resolving it needs the caller's property catalog, which this module deliberately does not read.
 */
export function buildUnifiedServiceRows(input: {
  addOns: readonly AddOnInput[];
  maintenance: readonly MaintenanceInput[];
  propertyLabelForRequest?: (propertyId: string) => string | null | undefined;
}): UnifiedServiceRow[] {
  const rows: UnifiedServiceRow[] = [];

  for (const req of input.addOns) {
    if (!req.id) continue;
    rows.push({
      id: req.id,
      kind: "add-on",
      title: req.offerName?.trim() || "Add-on service",
      statusLabel: titleCase(req.status) || "Pending",
      state: addOnState(req.status),
      residentName: req.residentName?.trim() ?? "",
      residentEmail: req.residentEmail?.trim() ?? "",
      propertyLabel: input.propertyLabelForRequest?.(req.propertyId ?? "")?.trim() ?? "",
      unitLabel: "",
      scheduledIso: req.approvedAt?.trim() ?? "",
      createdIso: req.requestedAt?.trim() ?? "",
    });
  }

  for (const wo of input.maintenance) {
    if (!wo.id) continue;
    rows.push({
      id: wo.id,
      kind: "maintenance",
      title: wo.title?.trim() || "Maintenance",
      statusLabel: wo.status?.trim() || titleCase(wo.bucket) || "Open",
      state: maintenanceState(wo.bucket),
      residentName: wo.residentName?.trim() ?? "",
      residentEmail: wo.residentEmail?.trim() ?? "",
      propertyLabel: wo.propertyName?.trim() ?? "",
      unitLabel: wo.unit?.trim() ?? "",
      scheduledIso: wo.scheduledAtIso?.trim() ?? "",
      createdIso: wo.createdAtIso?.trim() ?? "",
    });
  }

  return sortServiceRows(rows);
}

/**
 * Scheduled work first, soonest at the top, then unscheduled newest-first.
 *
 * A manager's next question is "what is happening next"; work with a time answers it, work
 * without one is a backlog. An unparseable date sorts as unscheduled rather than scrambling the
 * order around it.
 */
export function sortServiceRows(rows: UnifiedServiceRow[]): UnifiedServiceRow[] {
  const at = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };
  return [...rows].sort((a, b) => {
    const as = at(a.scheduledIso);
    const bs = at(b.scheduledIso);
    if (as !== null && bs !== null) return as - bs;
    if (as !== null) return -1;
    if (bs !== null) return 1;
    return (at(b.createdIso) ?? 0) - (at(a.createdIso) ?? 0);
  });
}

/** Count rows per state, for the filter pills over the merged list. */
export function countServiceRowsByState(
  rows: readonly UnifiedServiceRow[],
): Record<ServiceRowState, number> {
  const counts: Record<ServiceRowState, number> = { open: 0, scheduled: 0, done: 0, declined: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

function titleCase(value: string | undefined | null): string {
  const raw = value?.trim();
  if (!raw) return "";
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}
