/**
 * Time a brand-new resident service on arrival, so a manager never opens
 * Work orders to an empty "Not scheduled" row when their own painted
 * availability (or a PropLane pick) could already answer "when". Reuses the
 * Stage C suggestion engine (`suggestManagerTimeForKind`) — this module only
 * decides what to DO with the answer: book it outright, or merely propose it
 * for the manager to confirm.
 *
 * Booking only happens when nothing else is about to claim the row. Vendor
 * auto-dispatch already books its own vendor's next open slot
 * (`work-order-dispatch.server.ts`), so this never books ahead of it — it
 * proposes instead, and the dispatch pipeline stays the source of truth for
 * that row.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { suggestManagerTimeForKind } from "@/lib/manager-schedule-suggest.server";
import type { SuggestSource } from "@/lib/manager-schedule-suggest";
import { loadVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
import { track } from "@/lib/analytics/posthog";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { buildResidentWorkOrderUpdate } from "@/lib/work-order-resident-notifications";

export type AutoTimeOutcome =
  | { kind: "booked"; iso: string }
  | { kind: "proposed"; iso: string; source: SuggestSource }
  | { kind: "none" };

/**
 * The exact predicate `prepareDispatch` gates on before it does anything —
 * duplicated here (rather than imported) because `prepareDispatch` runs this
 * check against the ALREADY-PERSISTED row, while a caller of this module needs
 * the answer before persisting. Keep the two in lockstep by hand.
 */
export async function willDispatchRun(
  db: SupabaseClient,
  managerUserId: string,
  row: Pick<DemoManagerWorkOrderRow, "managerInitiated" | "bucket" | "vendorId" | "selfAssigned" | "category">,
): Promise<boolean> {
  if (row.managerInitiated === true) return false;
  if (row.bucket !== "open") return false;
  if (row.vendorId || row.selfAssigned) return false;
  if (!row.category) return false;
  const settings = await loadVendorDispatchSettings(db, managerUserId);
  return settings.mode !== "off";
}

/**
 * Time a freshly-filed resident service. Only ever touches a row with no
 * `scheduledAtIso` yet, still `open`, and not logged by the manager
 * themselves (a manager who books their own service already knows the time).
 *
 * - No suggestion on file (nothing painted, nothing pickable) → `none`,
 *   the row is returned unchanged.
 * - A painted-availability slot AND vendor dispatch will not also claim this
 *   row → BOOK it: the manager takes the visit themselves, exactly the fields
 *   `schedule-service-visit.ts` writes for a manual "You" booking.
 * - Anything else (a PropLane pick, or availability but dispatch is about to
 *   run) → only PROPOSE it. Proposing never interferes with vendor dispatch —
 *   a manager with auto-dispatch on still gets their vendor; they also see a
 *   suggested time to fall back on.
 */
export async function autoTimeNewWorkOrder(
  db: SupabaseClient,
  managerUserId: string,
  row: DemoManagerWorkOrderRow,
  opts?: { now?: Date; dispatchWillRun?: boolean },
): Promise<{ row: DemoManagerWorkOrderRow; outcome: AutoTimeOutcome }> {
  if (row.scheduledAtIso || row.bucket !== "open" || row.managerInitiated === true) {
    return { row, outcome: { kind: "none" } };
  }

  const now = opts?.now ?? new Date();
  const suggestion = await suggestManagerTimeForKind(db, managerUserId, {
    kind: "services",
    seed: row.id,
    excludeWorkOrderId: row.id,
    durationMinutes: 60,
    now,
  });
  if (!suggestion) return { row, outcome: { kind: "none" } };

  const { iso, source } = suggestion;
  const proposedVisit = { iso, source, suggestedAtIso: now.toISOString() };

  if (source === "availability" && opts?.dispatchWillRun !== true) {
    const bookedRow: DemoManagerWorkOrderRow = {
      ...row,
      bucket: "scheduled",
      status: "Scheduled",
      scheduledAtIso: iso,
      scheduled: formatPacificDateTime(iso),
      selfAssigned: true,
      proposedVisit,
    };
    track("service_visit_autotimed", managerUserId, { source, outcome: "booked", work_order_id: row.id });
    return { row: bookedRow, outcome: { kind: "booked", iso } };
  }

  track("service_visit_autotimed", managerUserId, { source, outcome: "proposed", work_order_id: row.id });
  return { row: { ...row, proposedVisit }, outcome: { kind: "proposed", iso, source } };
}

/**
 * Best-effort resident notice for a visit this module booked outright (never
 * for a mere proposal — the manager hasn't confirmed anything yet). Mirrors
 * the "visit_scheduled" copy `notifyResidentOfWorkOrderUpdate` sends for a
 * manual Schedule visit, but goes through the server-safe inbox delivery
 * (`portal-inbox-delivery.ts`) instead of that helper's client-only fetch —
 * there is no signed-in browser session here to carry the request.
 */
export async function notifyVisitAutoBooked(
  db: SupabaseClient,
  managerUserId: string,
  row: DemoManagerWorkOrderRow,
): Promise<void> {
  const residentEmail = row.residentEmail?.trim();
  if (!residentEmail?.includes("@") || !row.scheduledAtIso) return;
  try {
    const { data: managerProfile } = await db.from("profiles").select("email").eq("id", managerUserId).maybeSingle();
    const { subject, text } = buildResidentWorkOrderUpdate("visit_scheduled", row, { scheduledLabel: row.scheduled });
    await deliverPortalInboxMessage(db, {
      senderUserId: managerUserId,
      senderEmail: ((managerProfile?.email as string | null) ?? "").trim().toLowerCase() || "noreply@axis.local",
      fromName: "PropLane Portal",
      subject,
      text,
      toEmails: [residentEmail],
      eventCategory: "maintenance",
    });
  } catch (e) {
    console.error("notifyVisitAutoBooked failed", row.id, e);
  }
}
