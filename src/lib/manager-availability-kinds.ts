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

export type AvailabilityKind = "tours" | "services" | "tasks";
export type ManagerKindAvailabilityKind = Exclude<AvailabilityKind, "tours">;

export const AVAILABILITY_KINDS: readonly AvailabilityKind[] = ["tours", "services", "tasks"];

export const AVAILABILITY_KIND_LABELS: Record<AvailabilityKind, string> = {
  tours: "Tours",
  services: "Services",
  tasks: "Tasks",
};

/** Record type for a manager's services/tasks availability — never tours, see header. */
export const MANAGER_KIND_AVAILABILITY_RECORD_TYPE = "manager_kind_availability";

export function isAvailabilityKind(raw: unknown): raw is AvailabilityKind {
  return raw === "tours" || raw === "services" || raw === "tasks";
}

const KIND_KEY_RE = /^axis_mgr_avail_slots_v2_(.+)_kind_(services|tasks)$/;

/** Storage key for a manager's services/tasks availability. There is no tours variant — see header. */
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
