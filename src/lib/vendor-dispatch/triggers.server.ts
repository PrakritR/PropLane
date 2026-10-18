import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import { loadHouse } from "@/lib/vendor-dispatch/engine.server";
import { workspaceHasMatchingRule } from "@/lib/vendor-dispatch/match.server";
import { createDispatchRun, type CreateDispatchRunResult } from "@/lib/vendor-dispatch/runs.server";
import { firstNameOf } from "@/lib/vendor-dispatch/text";
import { formatPacificShort } from "@/lib/vendor-dispatch/time";
import { inferDispatchFromService } from "@/lib/vendor-dispatch/triage";

/**
 * What starts a dispatch run (vendor-dispatch-1018): a resident files a service, a tour is
 * booked at a house with a tour-host rule, a booking checks out at a house with a cleaner
 * rule. Each trigger only acts when the workspace has an ACTIVE rule for the job, so a
 * workspace without rules behaves exactly as before, and each is idempotent on its source.
 */

/** The workspace a house belongs to (its own, else the owner's default). */
export async function resolveOwnerAndWorkspace(
  db: SupabaseClient,
  input: { ownerUserId?: string | null; propertyId?: string | null },
): Promise<{ ownerUserId: string; workspaceId: string } | null> {
  let ownerUserId = input.ownerUserId?.trim() || "";
  let workspaceId = "";
  const propertyId = input.propertyId?.trim() || "";
  if (propertyId) {
    const { data } = await db
      .from("manager_property_records")
      .select("manager_user_id, workspace_id")
      .eq("id", propertyId)
      .maybeSingle();
    const row = data as { manager_user_id?: string | null; workspace_id?: string | null } | null;
    if (row) {
      if (!ownerUserId) ownerUserId = String(row.manager_user_id ?? "").trim();
      workspaceId = String(row.workspace_id ?? "").trim();
      // The owner is whoever owns the house: a caller cannot place a run on another owner's workspace.
      if (row.manager_user_id && ownerUserId && String(row.manager_user_id).trim() !== ownerUserId) return null;
    }
  }
  if (!ownerUserId) return null;
  if (!workspaceId) workspaceId = await userDefaultWorkspaceId(db, ownerUserId);
  return workspaceId ? { ownerUserId, workspaceId } : null;
}

/** A lockout is dispatched only for a texter the house roster knows: a resident with a lease HERE and a verified phone. */
export async function residentMatchesHouse(
  db: SupabaseClient,
  input: { ownerUserId: string; residentEmail: string | null | undefined; propertyId: string | null | undefined },
): Promise<boolean> {
  const email = input.residentEmail?.trim().toLowerCase() ?? "";
  const propertyId = input.propertyId?.trim() ?? "";
  if (!email || !propertyId) return false;
  try {
    const { data: profile } = await db.from("profiles").select("id, phone, phone_verified_at").eq("email", email).maybeSingle();
    const p = profile as { id?: string; phone?: string | null; phone_verified_at?: string | null } | null;
    if (!p?.id || !p.phone || !p.phone_verified_at) return false;
    const { data: leases, error } = await db
      .from("portal_lease_pipeline_records")
      .select("row_data")
      .eq("manager_user_id", input.ownerUserId)
      .eq("resident_email", email);
    if (error) return false;
    return ((leases ?? []) as Array<{ row_data?: { status?: unknown; propertyId?: unknown } | null }>).some(
      (lease) => lease.row_data?.status !== "Voided" && String(lease.row_data?.propertyId ?? "").trim() === propertyId,
    );
  } catch {
    return false;
  }
}

export type WorkOrderTriggerOutcome = "created" | "existing" | "no_rule" | "refused" | "no_vendors" | "skipped";

type WorkOrderRecord = { id: string; manager_user_id: string | null; row_data: DemoManagerWorkOrderRow | null };

function entryNoteFor(row: DemoManagerWorkOrderRow): string | undefined {
  const permission =
    row.entryPermission === "allowed" ? "may enter" : row.entryPermission === "resident_present" ? "resident will be home" : row.entryPermission === "call_first" ? "call first" : "";
  const note = row.entryNotes?.trim();
  return [permission, note].filter(Boolean).join("; ") || undefined;
}

/** Would a rule run this freshly filed service? (Also the predicate that keeps legacy auto-time and preferred-vendor offers out of its way.) */
export async function ruleWouldDispatchWorkOrder(
  db: SupabaseClient,
  managerUserId: string,
  row: Partial<DemoManagerWorkOrderRow>,
): Promise<boolean> {
  try {
    if (row.managerInitiated === true || row.bucket !== "open" || row.vendorId || row.selfAssigned) return false;
    const inferred = inferDispatchFromService(row);
    if (!inferred) return false;
    const propertyId = row.assignedPropertyId || row.propertyId || null;
    const scope = await resolveOwnerAndWorkspace(db, { ownerUserId: managerUserId, propertyId });
    if (!scope) return false;
    return await workspaceHasMatchingRule(db, {
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      trade: inferred.trade,
      issue: inferred.issue,
      propertyId,
      urgency: inferred.urgency,
    });
  } catch {
    return false;
  }
}

/**
 * A resident-filed service: when the workspace has an active rule for its trade and issue,
 * open a dispatch run (awaiting the manager's approval) instead of the legacy proposal.
 */
export async function maybeCreateRuleRunForWorkOrder(db: SupabaseClient, workOrderId: string): Promise<WorkOrderTriggerOutcome> {
  const { data } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  const record = data as WorkOrderRecord | null;
  const row = record?.row_data ?? null;
  const ownerUserId = record?.manager_user_id?.trim() ?? "";
  if (!record || !row || !ownerUserId) return "skipped";
  if (row.managerInitiated === true || row.bucket !== "open" || row.vendorId || row.selfAssigned || !row.category) return "skipped";

  const inferred = inferDispatchFromService(row);
  if (!inferred) return "skipped";
  const propertyId = row.assignedPropertyId || row.propertyId || null;
  const scope = await resolveOwnerAndWorkspace(db, { ownerUserId, propertyId });
  if (!scope) return "skipped";
  const matchInput = {
    workspaceId: scope.workspaceId,
    ownerUserId: scope.ownerUserId,
    trade: inferred.trade,
    issue: inferred.issue,
    propertyId,
    urgency: inferred.urgency,
  };
  if (!(await workspaceHasMatchingRule(db, matchInput))) return "no_rule";

  // A lockout opens a door: the texter must be a resident of THIS house by verified phone.
  if (inferred.issue === "lockout") {
    const matched = await residentMatchesHouse(db, { ownerUserId: scope.ownerUserId, residentEmail: row.residentEmail, propertyId });
    if (!matched) {
      await recordDispatchEvent(db, {
        ownerUserId: scope.ownerUserId,
        runId: workOrderId,
        event: "refused_unverified_lockout",
        detail: { propertyId },
      });
      await notifyManagerFromAgent(db, {
        landlordId: scope.ownerUserId,
        subject: `Lockout not dispatched: ${row.title || "Lockout"}`,
        text: [
          `A lockout was reported at ${row.propertyName || "a house"} but the person could not be matched to that house's residents by a verified phone, so no locksmith was sent.`,
          "",
          "Call them to confirm who they are, then dispatch from Services.",
        ].join("\n"),
        threadType: "dispatch_proposal",
        propertyId,
        workspaceId: scope.workspaceId,
      }).catch(() => undefined);
      return "refused";
    }
  }

  const house = await loadHouse(db, scope.ownerUserId, propertyId);
  const created: CreateDispatchRunResult = await createDispatchRun(db, {
    workspaceId: scope.workspaceId,
    ownerUserId: scope.ownerUserId,
    sourceType: "work_order",
    sourceId: workOrderId,
    trade: inferred.trade,
    issue: inferred.issue,
    urgency: inferred.urgency,
    propertyId,
    createdBy: null,
    residentEmail: row.residentEmail ?? null,
    workOrder: row,
    details: {
      what: row.title || undefined,
      area: house?.area || workOrderGeneralArea(row),
      houseLabel: house?.label || row.propertyName || "",
      address: row.propertyAddress || house?.address || "",
      room: row.unit && row.unit !== "-" && row.unit !== "—" ? row.unit : undefined,
      whenLabel: inferred.urgency === "emergency" ? "now" : row.preferredArrival && row.preferredArrival !== "Anytime" ? row.preferredArrival : undefined,
      personFirstName: firstNameOf(row.residentName),
      entryNote: entryNoteFor(row),
      summary: row.description || undefined,
    },
  });
  if (!created.ok) {
    if (created.reason === "no_vendors") {
      await notifyManagerFromAgent(db, {
        landlordId: scope.ownerUserId,
        subject: `No vendor to dispatch: ${row.title || "Service"}`,
        text: `Your rule matched "${row.title || "this service"}" but none of its vendors can be texted right now (no phone, opted out, or busy). Assign a vendor from Services.`,
        threadType: "dispatch_proposal",
        propertyId,
        workspaceId: scope.workspaceId,
      }).catch(() => undefined);
      return "no_vendors";
    }
    return "skipped";
  }
  return created.created ? "created" : "existing";
}

/* ----------------------------------- tours ----------------------------------- */

type PlannedTour = {
  id?: unknown;
  kind?: unknown;
  start?: unknown;
  end?: unknown;
  propertyId?: unknown;
  propertyTitle?: unknown;
  roomLabel?: unknown;
  attendeeName?: unknown;
  canceledAt?: unknown;
  assignee?: { type?: unknown } | null;
};

/**
 * A tour was booked. At a house with an active tour-host rule it opens a run: "Prospect
 * tour at <house> <time>, 30 min, pay $X", awaiting the manager's approval. A tour already
 * assigned to a team member is theirs, not a vendor's.
 */
export async function maybeDispatchTourHost(db: SupabaseClient, event: Record<string, unknown>): Promise<WorkOrderTriggerOutcome> {
  const tour = event as PlannedTour;
  const id = String(tour.id ?? "").trim();
  if (!id || String(tour.kind ?? "") !== "tour" || tour.canceledAt) return "skipped";
  if (tour.assignee && tour.assignee.type === "team") return "skipped";
  const propertyId = String(tour.propertyId ?? "").trim();
  const start = Date.parse(String(tour.start ?? ""));
  if (!propertyId || !Number.isFinite(start) || start < Date.now()) return "skipped";
  const scope = await resolveOwnerAndWorkspace(db, { propertyId });
  if (!scope) return "skipped";
  const matchInput = {
    workspaceId: scope.workspaceId,
    ownerUserId: scope.ownerUserId,
    trade: "tour_host",
    issue: "tour",
    propertyId,
    urgency: "routine" as const,
    at: new Date(),
  };
  if (!(await workspaceHasMatchingRule(db, matchInput))) return "no_rule";
  const end = Date.parse(String(tour.end ?? ""));
  const minutes = Number.isFinite(end) && end > start ? Math.round((end - start) / 60_000) : 30;
  const house = await loadHouse(db, scope.ownerUserId, propertyId);
  const created = await createDispatchRun(db, {
    workspaceId: scope.workspaceId,
    ownerUserId: scope.ownerUserId,
    sourceType: "tour",
    sourceId: id,
    trade: "tour_host",
    issue: "tour",
    urgency: "routine",
    propertyId,
    createdBy: null,
    details: {
      what: "Prospect tour",
      area: house?.area,
      houseLabel: house?.label || String(tour.propertyTitle ?? ""),
      address: house?.address,
      room: String(tour.roomLabel ?? "").trim() || undefined,
      whenLabel: formatPacificShort(new Date(start)),
      startIso: new Date(start).toISOString(),
      durationMinutes: minutes,
      personFirstName: firstNameOf(String(tour.attendeeName ?? "")),
    },
  });
  if (!created.ok) return created.reason === "no_vendors" ? "no_vendors" : "skipped";
  return created.created ? "created" : "existing";
}

/* --------------------------------- turnovers --------------------------------- */

export type TurnoverStay = {
  managerUserId: string;
  subjectId: string;
  checkInKey: string;
  checkOutKey: string | null;
  propertyId: string | null;
  propertyLabel: string;
  roomId?: string;
  roomLabel?: string;
};

/** The earliest check-in at the same house and room on or after this checkout. */
export function nextCheckInAfter(stays: TurnoverStay[], stay: TurnoverStay): string | null {
  const after = stays
    .filter(
      (other) =>
        other !== stay &&
        other.propertyId === stay.propertyId &&
        (other.roomId ?? "") === (stay.roomId ?? "") &&
        stay.checkOutKey &&
        other.checkInKey >= stay.checkOutKey,
    )
    .map((other) => other.checkInKey)
    .sort();
  return after[0] ?? null;
}

/** Checkout today or tomorrow (Pacific date keys) at a house with a cleaner rule opens a run due by the next check-in. */
export async function dispatchCleaningForStays(
  db: SupabaseClient,
  stays: TurnoverStay[],
  window: { todayKey: string; tomorrowKey: string },
  toCheckInIso: (dateKey: string) => string | null = () => null,
): Promise<{ created: number; checked: number }> {
  let created = 0;
  let checked = 0;
  for (const stay of stays) {
    const out = stay.checkOutKey;
    if (!out || !stay.propertyId || (out !== window.todayKey && out !== window.tomorrowKey)) continue;
    checked += 1;
    const scope = await resolveOwnerAndWorkspace(db, { propertyId: stay.propertyId });
    if (!scope) continue;
    const next = nextCheckInAfter(stays, stay);
    // A turnover is urgent by definition (taxonomy); a same-day next check-in only makes the deadline tighter.
    const urgency = "urgent" as const;
    const matchInput = {
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      trade: "cleaner",
      issue: "turnover",
      propertyId: stay.propertyId,
      urgency,
    };
    if (!(await workspaceHasMatchingRule(db, matchInput))) continue;
    const house = await loadHouse(db, scope.ownerUserId, stay.propertyId);
    const deadlineLabel = next ? `check-in ${new Date(`${next}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}` : undefined;
    const result = await createDispatchRun(db, {
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      sourceType: "cleaning",
      sourceId: `${stay.subjectId}:${out}`,
      trade: "cleaner",
      issue: "turnover",
      urgency,
      propertyId: stay.propertyId,
      createdBy: null,
      details: {
        what: "Turnover clean",
        area: house?.area,
        houseLabel: house?.label || stay.propertyLabel,
        address: house?.address,
        room: stay.roomLabel,
        whenLabel: out === window.todayKey ? "after checkout today" : "after checkout tomorrow",
        deadlineLabel,
        deadlineIso: next ? toCheckInIso(next) ?? undefined : undefined,
      },
    });
    if (result.ok && result.created) created += 1;
  }
  return { created, checked };
}
