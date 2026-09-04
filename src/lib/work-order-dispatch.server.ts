/**
 * Server-side vendor-dispatch pipeline. `prepareDispatch` runs after a resident
 * files a work order (deterministic vendor ranking — no LLM); `executeDispatch`
 * performs the assignment for BOTH approval surfaces (manager one-tap route and
 * the agent-chat confirm flow) and, in auto mode, the guardrailed auto path.
 * Every step records an audit_log intent row first — the dedupe key is what
 * makes client re-sync replays and double-taps harmless.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { ensureVendorAgentSession } from "@/lib/agent/vendor-agent.server";
import { track } from "@/lib/analytics/posthog";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { syncWorkOrderToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { DEFAULT_VISIT_DURATION_MINUTES } from "@/lib/vendor-availability";
import { resolveVendorNextAvailableSlot } from "@/lib/vendor-availability-server";
import { loadVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { suggestVendorsForWorkOrder } from "@/lib/work-order-auto-match";
import {
  evaluateDispatchGuardrails,
  guardrailsAllowAutoDispatch,
  isEmergencyWorkOrder,
  type WorkOrderDispatch,
  type WorkOrderRowWithDispatch,
} from "@/lib/work-order-dispatch";
import { loadManagerWorkOrders, loadVendorsForMatching } from "@/lib/tools/domains/work-orders";

type Db = SupabaseClient;

export type DispatchActor = { userId: string; email: string; fullName: string };

/**
 * Prepare a dispatch proposal for a freshly-filed resident work order. Safe to
 * call repeatedly with the same id (audit dedupe short-circuits replays).
 * No-ops entirely unless the owning manager has turned the feature on.
 */
export async function prepareDispatch(db: Db, workOrderId: string): Promise<void> {
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  const managerUserId = (record?.manager_user_id as string | null) ?? null;
  const row = (record?.row_data ?? null) as WorkOrderRowWithDispatch | null;
  if (!record || !managerUserId || !row) return;
  if (row.managerInitiated === true) return;
  if (row.bucket !== "open") return;
  if (row.vendorId || row.selfAssigned) return;
  if (!row.category) return;
  if (row.dispatch) return;

  const settings = await loadVendorDispatchSettings(db, managerUserId);
  if (settings.mode === "off") return;

  // Record intent first, idempotently — the client "replace" sync can replay a
  // new row many times, and only the first insert of this key proceeds.
  const nowIso = new Date().toISOString();
  const dedupeKey = `dispatch_prepare:${workOrderId}`;
  const { error: auditError } = await db.from("audit_log").insert({
    actor_user_id: managerUserId,
    landlord_id: managerUserId,
    action: "dispatch_prepare",
    tool_name: "vendor_dispatch",
    input_summary: { workOrderId },
    dedupe_key: dedupeKey,
    created_at: nowIso,
  });
  if (auditError) {
    if (auditError.code !== "23505") {
      console.error("prepareDispatch: audit intent write failed", auditError);
    }
    return;
  }

  const ctx = { db, landlordId: managerUserId };
  const [vendors, allWorkOrders] = await Promise.all([loadVendorsForMatching(ctx), loadManagerWorkOrders(ctx)]);
  const candidates = suggestVendorsForWorkOrder(row, vendors, { allWorkOrders });

  const where = row.unit && row.unit !== "—" ? `${row.propertyName} · ${row.unit}` : row.propertyName;
  if (candidates.length === 0) {
    await db.from("audit_log").update({ result_summary: { outcome: "no_match" } }).eq("dedupe_key", dedupeKey);
    await notifyManagerFromAgent(db, {
      landlordId: managerUserId,
      subject: `No vendor matched: ${row.title}`,
      text: [
        `PropLane couldn't find a matching vendor for "${row.title}" at ${where} (category: ${row.category}).`,
        "",
        "Add or tag a vendor for this trade, then assign manually from Work orders.",
      ].join("\n"),
      threadType: "dispatch_proposal",
      notify: settings.notify,
    });
    return;
  }

  const top = candidates[0];
  const guardrails = evaluateDispatchGuardrails(settings, row, top);
  const dispatch: WorkOrderDispatch = {
    status: "proposed",
    vendorId: top.vendorId,
    vendorName: top.vendorName,
    reasoning: top.reason,
    candidates: candidates.slice(0, 3).map((c) => ({ vendorId: c.vendorId, vendorName: c.vendorName, reason: c.reason })),
    guardrails,
    proposedAtIso: nowIso,
  };

  await db
    .from("portal_work_order_records")
    .update({ row_data: { ...row, dispatch }, updated_at: nowIso })
    .eq("id", workOrderId);
  await db
    .from("audit_log")
    .update({ result_summary: { outcome: "proposed", vendorId: top.vendorId } })
    .eq("dedupe_key", dedupeKey);
  track("work_order_dispatch_proposed", managerUserId, {
    work_order_id: workOrderId,
    category: row.category,
    mode: settings.mode,
  });

  if (settings.mode === "auto" && guardrailsAllowAutoDispatch(guardrails)) {
    const { data: managerProfile } = await db.from("profiles").select("email").eq("id", managerUserId).maybeSingle();
    const result = await executeDispatch(db, {
      workOrderId,
      landlordId: managerUserId,
      actor: {
        userId: managerUserId,
        email: ((managerProfile?.email as string | null) ?? "").trim().toLowerCase(),
        fullName: "PropLane Assistant",
      },
      decidedBy: "auto",
    });
    if (result.ok) {
      // ponytail: no quiet-hours suppression — every channel fires immediately;
      // add a deferred-SMS pass on a cron if after-hours pings become a complaint.
      await notifyManagerFromAgent(db, {
        landlordId: managerUserId,
        subject: `${isEmergencyWorkOrder(row) ? "Emergency dispatched" : "Dispatched"}: ${row.title}`,
        text: [
          `PropLane dispatched ${result.vendorName} for "${row.title}" at ${where} (${top.reason}).`,
          result.scheduledIso
            ? `Visit booked for ${formatPacificDateTime(result.scheduledIso)}.`
            : "No availability was on file, so pick a visit time from Work orders.",
          "",
          "Open Work orders to review or reassign.",
        ].join("\n"),
        threadType: "dispatch_proposal",
        notify: settings.notify,
      });
      return;
    }
    // Auto execution failed (vendor vanished, race, etc.) — downgrade to a normal
    // proposal rather than silently dropping the ticket.
  }

  await notifyManagerFromAgent(db, {
    landlordId: managerUserId,
    subject: `Dispatch ready: ${row.title}`,
    text: [
      `PropLane suggests ${top.vendorName} for "${row.title}" at ${where} (${top.reason}).`,
      "",
      "Open Work orders to approve with one tap, pick another vendor, or decline.",
    ].join("\n"),
    threadType: "dispatch_proposal",
    notify: settings.notify,
  });
}

export type ExecuteDispatchResult =
  | { ok: true; scheduledIso: string | null; vendorName: string }
  | { ok: false; error: string; status: number };

/**
 * Execute a pending proposal: assign the vendor, book their next open slot when
 * availability exists, and notify them. The caller supplies only workOrderId —
 * vendor choice and everything else re-derives from the persisted proposal, so
 * a forged request body cannot redirect the dispatch.
 */
export async function executeDispatch(
  db: Db,
  args: { workOrderId: string; landlordId: string; actor: DispatchActor; decidedBy: "manager" | "auto" },
): Promise<ExecuteDispatchResult> {
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data")
    .eq("id", args.workOrderId)
    .maybeSingle();
  const row = (record?.row_data ?? null) as WorkOrderRowWithDispatch | null;
  if (!record || !row) return { ok: false, error: "Work order not found.", status: 404 };
  if ((record.manager_user_id as string | null) !== args.landlordId) {
    return { ok: false, error: "Forbidden.", status: 403 };
  }
  const dispatch = row.dispatch;
  if (!dispatch || dispatch.status !== "proposed") {
    return { ok: false, error: "No pending dispatch proposal for this work order.", status: 409 };
  }
  if (row.vendorId || row.selfAssigned) {
    return { ok: false, error: "A vendor is already assigned.", status: 409 };
  }

  // The proposed vendor must still belong to this manager (or be shared) —
  // same ownership gate as resolveVendorUserId in the work-orders route.
  const { data: vendor } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", dispatch.vendorId)
    .maybeSingle();
  const vendorRowData = (vendor?.row_data ?? {}) as { name?: string; email?: string; sharedWithManagers?: boolean };
  const vendorAvailable =
    vendor && (vendor.manager_user_id === args.landlordId || vendorRowData.sharedWithManagers === true);
  if (!vendorAvailable) {
    return { ok: false, error: "This vendor is no longer available to you.", status: 409 };
  }

  const nowIso = new Date().toISOString();
  const dedupeKey = `dispatch_execute:${args.workOrderId}`;
  const { error: auditError } = await db.from("audit_log").insert({
    actor_user_id: args.actor.userId,
    landlord_id: args.landlordId,
    action: "dispatch_execute",
    tool_name: "vendor_dispatch",
    input_summary: { workOrderId: args.workOrderId, vendorId: dispatch.vendorId, decidedBy: args.decidedBy },
    dedupe_key: dedupeKey,
    created_at: nowIso,
  });
  if (auditError) {
    if (auditError.code === "23505") {
      return { ok: false, error: "This work order was already dispatched.", status: 409 };
    }
    return { ok: false, error: "Could not record the action; nothing was dispatched.", status: 500 };
  }

  const vendorUserId = (vendor.vendor_user_id as string | null) ?? null;
  let scheduledIso: string | null = null;
  if (vendorUserId) {
    const slot = await resolveVendorNextAvailableSlot(db, vendorUserId, {
      durationMinutes: DEFAULT_VISIT_DURATION_MINUTES,
      excludeWorkOrderId: args.workOrderId,
    });
    scheduledIso = slot.iso;
  }

  const vendorName = vendorRowData.name || dispatch.vendorName;
  const nextRow: WorkOrderRowWithDispatch = {
    ...row,
    vendorId: dispatch.vendorId,
    vendorName,
    vendorAssignedAt: nowIso,
    selfAssigned: false,
    dispatch: {
      ...dispatch,
      status: args.decidedBy === "auto" ? "auto_dispatched" : "approved",
      decidedAtIso: nowIso,
      decidedBy: args.decidedBy,
    },
    ...(scheduledIso
      ? {
          bucket: "scheduled" as const,
          status: "Scheduled",
          scheduledAtIso: scheduledIso,
          scheduled: formatPacificDateTime(scheduledIso),
        }
      : {}),
  };

  const { error: updateError } = await db
    .from("portal_work_order_records")
    .update({ vendor_user_id: vendorUserId, row_data: nextRow, updated_at: nowIso })
    .eq("id", args.workOrderId);
  if (updateError) {
    // Clear the dedupe key so a retry can record a fresh attempt (email_failed pattern).
    await db
      .from("audit_log")
      .update({ result_summary: { outcome: "failed", error: updateError.message }, dedupe_key: null })
      .eq("dedupe_key", dedupeKey);
    return { ok: false, error: "Failed to assign the vendor.", status: 500 };
  }

  if (scheduledIso) {
    const syncedRow = await syncWorkOrderToGoogleCalendar(db, args.landlordId, nextRow).catch(() => nextRow);
    if (syncedRow.googleCalendarEventId !== nextRow.googleCalendarEventId) {
      await db
        .from("portal_work_order_records")
        .update({ row_data: syncedRow, updated_at: nowIso })
        .eq("id", args.workOrderId);
    }
  }

  const residentEmail = (row.residentEmail ?? "").trim();
  await workOrderEvent(db, {
    eventId: `${args.workOrderId}:${scheduledIso ? "scheduled" : "accepted"}:${dedupeKey}`,
    event: scheduledIso ? "scheduled" : "accepted",
    managerUserId: args.landlordId,
    workOrderId: args.workOrderId,
    senderUserId: args.actor.userId,
    senderEmail: args.actor.email,
    senderName: args.actor.fullName,
    facts: {
      reference: row.reference || "Work order",
      title: row.title || "Work order",
      propertyLabel: row.propertyName || undefined,
      scheduledFor: scheduledIso ? formatPacificDateTime(scheduledIso) : undefined,
      vendorName,
      emergency: isEmergencyWorkOrder(row),
    },
    recipients: [
      { audience: "vendor", userId: vendorUserId ?? undefined, email: (vendorRowData.email ?? "").trim() || undefined },
      ...(residentEmail ? [{ audience: "resident" as const, email: residentEmail }] : []),
    ],
  }).catch(() => undefined);

  // Open the 24/7 conversation for this job when the manager opted in.
  const settings = await loadVendorDispatchSettings(db, args.landlordId);
  if (settings.agentMessagingEnabled) {
    await ensureVendorAgentSession(db, {
      landlordId: args.landlordId,
      workOrderId: args.workOrderId,
      vendorDirectoryId: dispatch.vendorId,
      vendorUserId,
      vendorName,
      workOrderTitle: row.title,
      propertyLabel: row.propertyName,
    }).catch((e) => console.error("ensureVendorAgentSession failed", e));
  }

  await db
    .from("audit_log")
    .update({
      result_summary: { outcome: args.decidedBy === "auto" ? "auto_dispatched" : "approved", vendorId: dispatch.vendorId, scheduledIso },
    })
    .eq("dedupe_key", dedupeKey);
  track(
    args.decidedBy === "auto" ? "work_order_dispatch_auto_executed" : "work_order_dispatch_approved",
    args.landlordId,
    { work_order_id: args.workOrderId },
  );
  return { ok: true, scheduledIso, vendorName };
}

export type DeclineDispatchResult = { ok: true } | { ok: false; error: string; status: number };

export async function declineDispatch(
  db: Db,
  args: { workOrderId: string; landlordId: string; actorUserId: string },
): Promise<DeclineDispatchResult> {
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data")
    .eq("id", args.workOrderId)
    .maybeSingle();
  const row = (record?.row_data ?? null) as WorkOrderRowWithDispatch | null;
  if (!record || !row) return { ok: false, error: "Work order not found.", status: 404 };
  if ((record.manager_user_id as string | null) !== args.landlordId) {
    return { ok: false, error: "Forbidden.", status: 403 };
  }
  if (!row.dispatch || row.dispatch.status !== "proposed") {
    return { ok: false, error: "No pending dispatch proposal for this work order.", status: 409 };
  }

  const nowIso = new Date().toISOString();
  const declined: WorkOrderDispatch = { ...row.dispatch, status: "declined", decidedAtIso: nowIso, decidedBy: "manager" };
  await db
    .from("portal_work_order_records")
    .update({ row_data: { ...row, dispatch: declined }, updated_at: nowIso })
    .eq("id", args.workOrderId);
  await db.from("audit_log").insert({
    actor_user_id: args.actorUserId,
    landlord_id: args.landlordId,
    action: "dispatch_decline",
    tool_name: "vendor_dispatch",
    input_summary: { workOrderId: args.workOrderId, vendorId: declined.vendorId },
    dedupe_key: `dispatch_decline:${args.workOrderId}`,
    created_at: nowIso,
  });
  track("work_order_dispatch_declined", args.landlordId, { work_order_id: args.workOrderId });
  return { ok: true };
}
