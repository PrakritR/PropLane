/**
 * The four service stage ids, labels and legacy-id parsing, with no dependencies, so routing code
 * (`portal-detail-routes.ts`) can use them without pulling in the bid cycle.
 * `service-lifecycle.ts` re-exports everything here and owns the rest of the vocabulary.
 */

export const SERVICE_STAGE_IDS = ["open", "assigned", "scheduled", "completed"] as const;
export type ServiceStage = (typeof SERVICE_STAGE_IDS)[number];

export const SERVICE_STAGE_LABEL: Record<ServiceStage, string> = {
  open: "Open",
  assigned: "Assigned",
  scheduled: "Scheduled",
  completed: "Completed",
};

/** The tabs every service list renders, in order. */
export const SERVICE_STAGE_TABS: ReadonlyArray<{ id: ServiceStage; label: string }> = SERVICE_STAGE_IDS.map((id) => ({
  id,
  label: SERVICE_STAGE_LABEL[id],
}));

/**
 * Old tab / bucket ids that may still arrive in a URL, a saved link or an email, mapped onto the
 * four stages. `active` / `current` / `upcoming` resolve to `scheduled`; the caller may refine
 * with data (an assigned row with no time belongs on `assigned`), but a link never falls home.
 */
const LEGACY_STAGE_ALIASES: Record<string, ServiceStage> = {
  open: "open",
  pending: "open",
  potential: "open",
  requested: "open",
  requests: "open",
  new: "open",
  "in-progress": "open",
  overdue: "open",
  assigned: "assigned",
  approved: "assigned",
  hired: "assigned",
  scheduled: "scheduled",
  active: "scheduled",
  current: "scheduled",
  upcoming: "scheduled",
  completed: "completed",
  complete: "completed",
  done: "completed",
  past: "completed",
  closed: "completed",
  paid: "completed",
  declined: "completed",
  denied: "completed",
};

export function parseServiceStage(raw: string | null | undefined): ServiceStage {
  const key = (raw ?? "").trim().toLowerCase();
  return LEGACY_STAGE_ALIASES[key] ?? "open";
}

export function isServiceStage(raw: string | null | undefined): raw is ServiceStage {
  return (SERVICE_STAGE_IDS as readonly string[]).includes(raw ?? "");
}
