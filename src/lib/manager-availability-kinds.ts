/**
 * Availability "kinds" a manager can paint on the calendar: exactly Tours,
 * Services and Tasks. Tours is the original, public-facing kind; services and
 * tasks are manager-only.
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

/**
 * Inspections and move-ins/outs used to be their own availability kinds. They
 * are Tasks now: nothing writes these two any more, but records already saved
 * under them are read as task availability (merged on read) so no manager loses
 * hours. A write to Tasks folds any legacy run into the Tasks record.
 */
export type LegacyTaskAvailabilityKind = "inspections" | "moves";
export const LEGACY_TASK_AVAILABILITY_KINDS: readonly LegacyTaskAvailabilityKind[] = ["inspections", "moves"];

export const AVAILABILITY_KINDS: readonly AvailabilityKind[] = ["tours", "services", "tasks"];

/** Every kind that is stored under the per-manager kind key (everything except tours). */
export const MANAGER_KIND_AVAILABILITY_KINDS: readonly ManagerKindAvailabilityKind[] = ["services", "tasks"];

export const AVAILABILITY_KIND_LABELS: Record<AvailabilityKind, string> = {
  tours: "Tours",
  services: "Services",
  tasks: "Tasks",
};

/**
 * All three kinds open at once. Not a stored kind and not a picker option: a
 * painted run that is open for every kind reads as the plain hatch.
 */
export function isEverythingKinds(kinds: readonly AvailabilityKind[]): boolean {
  return AVAILABILITY_KINDS.every((kind) => kinds.includes(kind));
}

/** Folds a stored or legacy kind name onto the three real kinds (inspections and moves are tasks). */
export function normalizeAvailabilityKind(raw: unknown): AvailabilityKind | null {
  if (raw === "tours" || raw === "services" || raw === "tasks") return raw;
  if (raw === "inspections" || raw === "moves") return "tasks";
  return null;
}

/** Record type for a manager's services/tasks availability — never tours, see header. */
export const MANAGER_KIND_AVAILABILITY_RECORD_TYPE = "manager_kind_availability";

export function isAvailabilityKind(raw: unknown): raw is AvailabilityKind {
  return raw === "tours" || raw === "services" || raw === "tasks";
}

const KIND_KEY_RE = /^axis_mgr_avail_slots_v2_(.+)_kind_(services|tasks|inspections|moves)$/;

/** Storage key for a manager's services/tasks availability (or a legacy inspections/moves key). There is no tours variant — see header. */
export function managerKindAvailabilityStorageKey(
  userId: string,
  kind: ManagerKindAvailabilityKind | LegacyTaskAvailabilityKind,
): string {
  return `axis_mgr_avail_slots_v2_${userId.trim()}_kind_${kind}`;
}

export function parseManagerKindAvailabilityStorageKey(
  key: string,
): { userId: string; kind: ManagerKindAvailabilityKind | LegacyTaskAvailabilityKind } | null {
  const match = KIND_KEY_RE.exec(key);
  if (!match) return null;
  const userId = match[1];
  if (!userId) return null;
  return { userId, kind: match[2] as ManagerKindAvailabilityKind | LegacyTaskAvailabilityKind };
}

/** The legacy inspections + moves keys a manager's task availability is also read from. */
export function legacyTaskAvailabilityStorageKeys(userId: string): string[] {
  return LEGACY_TASK_AVAILABILITY_KINDS.map((kind) => managerKindAvailabilityStorageKey(userId, kind));
}

/** For a Tasks storage key, the legacy keys that read as tasks too; empty for any other key. */
export function legacyTaskKeysForStorageKey(key: string): string[] {
  const parsed = parseManagerKindAvailabilityStorageKey(key);
  return parsed?.kind === "tasks" ? legacyTaskAvailabilityStorageKeys(parsed.userId) : [];
}

/** Every key a kind's slots are READ from: its own keys, plus the legacy keys for Tasks. */
export function readKeysForKindStorageKeys(keys: readonly string[]): string[] {
  const out = new Set<string>(keys);
  for (const key of keys) for (const legacy of legacyTaskKeysForStorageKey(key)) out.add(legacy);
  return [...out];
}

/** Which kind newly-painted availability belongs to, keyed off the calendar view a manager is on. */
export function defaultAvailabilityKindForCalendarView(view: string): AvailabilityKind {
  if (view === "services") return "services";
  if (view === "tasks") return "tasks";
  return "tours";
}
