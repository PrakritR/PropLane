/**
 * Availability "kinds" a manager can paint on the calendar. Tours is the
 * original, public-facing kind; services and tasks are new and manager-only.
 *
 * Tours deliberately has NO kind-scoped key here. Its storage keeps the
 * existing per-house (`managerPropertyAvailabilityStorageKey`) and portfolio
 * (`managerAvailabilityStorageKey`) keys in `demo-admin-scheduling.ts`,
 * because the PUBLIC tour booking route reads those `manager_property_availability`
 * / `manager_availability` records directly as tour offerings. A parallel
 * `_kind_tours` key would either have to be added to that public read path too
 * (widening what a prospect's request can reach) or would silently do nothing
 * when painted. Services and tasks must never be offered to a prospect, so
 * they get one new record type instead: `MANAGER_KIND_AVAILABILITY_RECORD_TYPE`,
 * which the public route never touches.
 */

export type AvailabilityKind = "tours" | "services" | "tasks" | "inspections" | "moves";
export type ManagerKindAvailabilityKind = Exclude<AvailabilityKind, "tours">;

export const AVAILABILITY_KINDS: readonly AvailabilityKind[] = ["tours", "services", "tasks", "inspections", "moves"];

/** Every kind that is stored under the per-manager kind key (everything except tours). */
export const MANAGER_KIND_AVAILABILITY_KINDS: readonly ManagerKindAvailabilityKind[] = [
  "services",
  "tasks",
  "inspections",
  "moves",
];

export const AVAILABILITY_KIND_LABELS: Record<AvailabilityKind, string> = {
  tours: "Tours",
  services: "Services",
  tasks: "Tasks",
  inspections: "Inspections",
  moves: "Move-ins and move-outs",
};

/**
 * "Everything" is not a stored kind: it is a window written to every kind. A
 * painted run that is open for all of them reads as Everything (the plain
 * hatch); anything narrower is a typed band (C2-CALA2/CALA6).
 */
export function isEverythingKinds(kinds: readonly AvailabilityKind[]): boolean {
  return AVAILABILITY_KINDS.every((kind) => kinds.includes(kind));
}

/** Record type for a manager's services/tasks availability — never tours, see header. */
export const MANAGER_KIND_AVAILABILITY_RECORD_TYPE = "manager_kind_availability";

export function isAvailabilityKind(raw: unknown): raw is AvailabilityKind {
  return raw === "tours" || raw === "services" || raw === "tasks" || raw === "inspections" || raw === "moves";
}

const KIND_KEY_RE = /^axis_mgr_avail_slots_v2_(.+)_kind_(services|tasks|inspections|moves)$/;

/** Storage key for a manager's services/tasks/inspections/moves availability. There is no tours variant — see header. */
export function managerKindAvailabilityStorageKey(userId: string, kind: ManagerKindAvailabilityKind): string {
  return `axis_mgr_avail_slots_v2_${userId.trim()}_kind_${kind}`;
}

export function parseManagerKindAvailabilityStorageKey(
  key: string,
): { userId: string; kind: ManagerKindAvailabilityKind } | null {
  const match = KIND_KEY_RE.exec(key);
  if (!match) return null;
  const userId = match[1];
  if (!userId) return null;
  return { userId, kind: match[2] as ManagerKindAvailabilityKind };
}

/** Which kind newly-painted availability belongs to, keyed off the calendar view a manager is on. */
export function defaultAvailabilityKindForCalendarView(view: string): AvailabilityKind {
  if (view === "services") return "services";
  if (view === "tasks") return "tasks";
  return "tours";
}
