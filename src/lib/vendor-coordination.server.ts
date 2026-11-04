import { coordinationQuote } from "@/lib/vendor-coordination-view";
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { quoteTotalCents, intersectVisitWindows, type CoordinationAction, type CoordinationProposal } from "@/lib/vendor-coordination";
import { retryDueActionEventDeliveries } from "@/lib/action-events.server";
import { track } from "@/lib/analytics/posthog";

export type CoordinationActor = { role: "manager" | "vendor" | "resident"; userId: string; email: string; managerUserId?: string; vendorDirectoryId?: string; workOrderId?: string; verifiedPhone?: string; sourceMessageId?: string };
const vendorActions = new Set(["revise_quote", "submit_vendor_windows", "confirm_vendor"]);
const residentActions = new Set(["submit_resident_windows", "confirm_resident"]);

/** Rechecked before every read and action. Directory contacts never become synthetic auth users. */
export async function coordinationWorkOrderAccess(db: SupabaseClient, actor: CoordinationActor, workOrderId: string, directoryId?: string) {
  const { data: work, error } = await db.from("portal_work_order_records").select("id,manager_user_id,vendor_user_id,resident_user_id,resident_email,row_data").eq("id", workOrderId).maybeSingle();
  if (error || !work) throw new Error("Service unavailable.");
  if (actor.workOrderId && actor.workOrderId !== workOrderId) throw new Error("Forbidden.");
  if (actor.managerUserId && actor.managerUserId !== work.manager_user_id) throw new Error("Forbidden.");
  if (actor.role === "manager") {
    // Delegated manager actions need the existing property permission adapter before enrolment.
    if (work.manager_user_id !== actor.userId) throw new Error("Forbidden.");
  } else if (actor.role === "resident") {
    if (!actor.userId || work.resident_user_id !== actor.userId) throw new Error("Forbidden.");
  } else {
    let query = db.from("manager_vendor_records").select("id,vendor_user_id,row_data").eq("manager_user_id", work.manager_user_id);
    query = actor.vendorDirectoryId ? query.eq("id", actor.vendorDirectoryId) : query.eq("vendor_user_id", actor.userId);
    if (directoryId) query = query.eq("id", directoryId);
    const { data: directories, error: directoryError } = await query;
    if (directoryError) throw new Error("Forbidden.");
    const matching = (directories ?? []).filter((d) => actor.vendorDirectoryId || d.vendor_user_id === actor.userId);
    const ids = matching.map((d) => String(d.id));
    if (!ids.length) throw new Error("Forbidden.");
    const assigned = ids.includes(String(work.row_data?.vendorId ?? "")) && !work.row_data?.selfAssigned;
    const { data: offers, error: offerError } = await db.from("work_order_vendor_offers").select("vendor_directory_id,expires_at").eq("work_order_id", workOrderId).eq("status", "sent").in("vendor_directory_id", ids);
    if (offerError || (!assigned && !(offers ?? []).some((o) => o.expires_at && Date.parse(o.expires_at) > Date.now()))) throw new Error("Forbidden.");
  }
  return work;
}

export async function workOrderCoordinationEnrolled(db: SupabaseClient, workOrderId: string) {
  const { data, error } = await db.from("vendor_coordination_proposals").select("id").eq("work_order_id", workOrderId).in("status", ["collecting", "ready", "approved"]).limit(1);
  if (error) throw new Error("Coordination state unavailable.");
  return Boolean(data?.length);
}

export async function listCoordination(db: SupabaseClient, actor: CoordinationActor, workOrderId: string): Promise<CoordinationProposal[]> {
  await coordinationWorkOrderAccess(db, actor, workOrderId);
  let query = db.from("vendor_coordination_proposals").select("*").eq("work_order_id", workOrderId);
  if (actor.role === "vendor") {
    if (actor.vendorDirectoryId) query = query.eq("vendor_directory_id", actor.vendorDirectoryId);
    else query = query.eq("vendor_user_id", actor.userId);
  }
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((p) => publicCoordinationProposal(p as CoordinationProposal, actor)) as CoordinationProposal[];
}

export async function coordinationProposal(db: SupabaseClient, actor: CoordinationActor, proposalId: string) {
  const { data: proposal, error } = await db.from("vendor_coordination_proposals").select("*").eq("id", proposalId).maybeSingle();
  if (error || !proposal) throw new Error("Proposal unavailable.");
  await coordinationWorkOrderAccess(db, actor, proposal.work_order_id, proposal.vendor_directory_id);
  return proposal as CoordinationProposal;
}

/** SQL owns versions, terms, agreement and booking. No caller can substitute identities. */
export async function applyCoordinationAction(db: SupabaseClient, actor: CoordinationActor, input: CoordinationAction) {
  if (actor.role === "vendor" && !vendorActions.has(input.kind)) throw new Error("Forbidden.");
  if (actor.role === "resident" && !residentActions.has(input.kind)) throw new Error("Forbidden.");
  const proposal = input.kind === "enroll" ? null : await coordinationProposal(db, actor, input.proposal_id);
  const work = await coordinationWorkOrderAccess(db, actor, input.kind === "enroll" ? input.work_order_id : proposal!.work_order_id,
    input.kind === "enroll" ? input.vendor_directory_id : proposal!.vendor_directory_id);
  const action = { ...input, source_message_id: actor.sourceMessageId ?? input.source_message_id, verified_phone_e164: actor.verifiedPhone, actor_user_id: actor.userId || undefined,
    manager_user_id: work.manager_user_id,

    vendor_directory_id: actor.role === "vendor" ? (actor.vendorDirectoryId ?? proposal?.vendor_directory_id) : input.kind === "enroll" ? input.vendor_directory_id : undefined };
  const { data, error } = await db.rpc("vendor_coordination_action", { p_action: action });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  if (["revise_quote", "submit_vendor_windows", "submit_resident_windows"].includes(input.kind) && input.kind !== "enroll") await suggestAgreedTime(db, input.proposal_id);
  // Delivery intent was committed by the RPC. Retry uses a stable event id, never another booking.
  await flushCoordinationEvents(db, work.manager_user_id).catch((error) => console.error("Coordination delivery pending", error instanceof Error ? error.message : "unknown"));
  track("work_order_coordination_updated", actor.userId || work.manager_user_id, { work_order_id: work.id, action: input.kind });
  return publicCoordinationProposal(data, actor);
}

export async function coordinationPreview(db: SupabaseClient, actor: CoordinationActor, proposalId: string, expectedVersion: number) {
  const proposal = await coordinationProposal(db, actor, proposalId);
  if (proposal.version !== expectedVersion) throw new Error("Proposal changed. Review the current terms.");
  const { data: vendor } = await db.from("manager_vendor_records").select("row_data").eq("manager_user_id", proposal.manager_user_id).eq("id", proposal.vendor_directory_id).maybeSingle();
  return { proposal, vendorName: String(vendor?.row_data?.name || "Vendor"), totalCents: coordinationQuote(proposal) ? quoteTotalCents(proposal.visit_type, coordinationQuote(proposal)!) : null,
    candidates: await visitCandidates(db, proposal) };
}

export async function flushCoordinationEvents(db: SupabaseClient, managerUserId: string) {
  const { data, error } = await db.from("action_events").select("id").eq("manager_user_id", managerUserId).like("event_key", "vendor_coordination:%").order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return retryDueActionEventDeliveries(db, { limit: 30, eventIds: (data ?? []).map((e) => String(e.id)) });
}

export async function coordinationVendorChoices(db: SupabaseClient, actor: CoordinationActor, workOrderId: string) {
  if (actor.role !== "manager") return [];
  const work = await coordinationWorkOrderAccess(db, actor, workOrderId);
  const { data: offers, error } = await db.from("work_order_vendor_offers").select("vendor_directory_id,expires_at").eq("work_order_id", workOrderId).eq("manager_user_id", work.manager_user_id).eq("status", "sent");
  if (error) throw new Error("Vendor offers unavailable.");
  const ids = [...new Set([work.row_data?.vendorId, ...(offers ?? []).filter((o) => o.expires_at && Date.parse(o.expires_at) > Date.now()).map((o) => o.vendor_directory_id)].filter(Boolean))];
  if (!ids.length) return [];
  const { data: vendors, error: vendorError } = await db.from("manager_vendor_records").select("id,row_data").eq("manager_user_id", work.manager_user_id).in("id", ids);
  if (vendorError) throw new Error("Vendors unavailable.");
  return (vendors ?? []).map((v) => ({ id: String(v.id), name: String(v.row_data?.name || "Vendor") }));
}

/** Only intervals leave this helper; another manager's job/contact details never do. */
export async function visitCandidates(db: SupabaseClient, proposal: CoordinationProposal) {
  if (!proposal.duration_minutes || !proposal.vendor_windows.length || !proposal.resident_windows.length) return [];
  const { data: binding, error: bindingError } = await db.from("vendor_coordination_phone_bindings").select("phone_e164").eq("manager_user_id", proposal.manager_user_id).eq("vendor_directory_id", proposal.vendor_directory_id).is("revoked_at", null).maybeSingle();
  if (bindingError) throw new Error("Availability unavailable.");
  let query = db.from("vendor_coordination_reservations").select("starts_at,ends_at,proposal_id").eq("status", "active").gt("ends_at", new Date().toISOString());
  if (binding?.phone_e164) query = query.eq("vendor_phone_e164", binding.phone_e164);
  else if (proposal.vendor_user_id) query = query.eq("vendor_user_id", proposal.vendor_user_id);
  else return [];
  const { data: reservations, error } = await query;
  if (error) throw new Error("Availability unavailable.");
  const busy = (reservations ?? []).filter((r) => r.proposal_id !== proposal.id).map((r) => ({ startIso: r.starts_at, endIso: r.ends_at }));
  if (proposal.vendor_user_id) {
    const { data: legacy, error: legacyError } = await db.from("portal_work_order_records").select("id,row_data").eq("vendor_user_id", proposal.vendor_user_id);
    if (legacyError) throw new Error("Availability unavailable.");
    for (const row of legacy ?? []) { if (row.id === proposal.work_order_id || ["completed", "cancelled"].includes(row.row_data?.bucket)) continue;
      for (const [time, duration] of [[row.row_data?.scheduledAtIso, row.row_data?.visitDurationMinutes ?? 60], [row.row_data?.consultationVisitAt, row.row_data?.consultationDurationMinutes ?? 60]]) {
        if (typeof time === "string" && Number.isFinite(Date.parse(time))) busy.push({ startIso: time, endIso: new Date(Date.parse(time) + Number(duration) * 60000).toISOString() });
      }
    }
  }
  return intersectVisitWindows(proposal.vendor_windows, proposal.resident_windows, busy, proposal.duration_minutes)
    .flatMap((w) => { const start = Math.max(Date.parse(w.startIso), Math.ceil(Date.now() / 900000) * 900000); return start + proposal.duration_minutes! * 60000 <= Date.parse(w.endIso) ? [{ startIso: new Date(start).toISOString(), endIso: w.endIso }] : []; });
}

/** Choosing a proposal commits no visit. The manager's enrolled service may coordinate deterministically. */
async function suggestAgreedTime(db: SupabaseClient, proposalId: string) {
  const { data: p, error } = await db.from("vendor_coordination_proposals").select("*").eq("id", proposalId).maybeSingle();
  if (error || !p || p.manager_takeover || p.selected_start_at || p.status !== "collecting") return;
  const windows = await visitCandidates(db, p as CoordinationProposal);
  if (!windows.length) return;
  const { error: selectError } = await db.rpc("vendor_coordination_action", { p_action: { kind: "select_time", proposal_id: p.id, expected_version: p.version, actor_user_id: p.manager_user_id, selected_start_iso: windows[0]!.startIso } });
  // A concurrent response wins. Never substitute a different version or promise a slot.
  if (selectError && !selectError.message.includes("stale")) throw new Error(selectError.message);
}


function publicCoordinationProposal(p: CoordinationProposal, actor: CoordinationActor) {
  if (actor.role !== "resident") return p;
  return { id: p.id, work_order_id: p.work_order_id, visit_type: p.visit_type, version: p.version,
    quote_revision: p.quote_revision, status: p.status, duration_minutes: p.duration_minutes,
    selected_start_at: p.selected_start_at, vendor_windows: p.vendor_windows, resident_windows: p.resident_windows,
    vendor_confirmed_revision: p.vendor_confirmed_revision, resident_confirmed_revision: p.resident_confirmed_revision,
    manager_user_id: "", vendor_directory_id: "", vendor_user_id: null,
    labor_cents: null, materials_cents: null, consultation_fee_cents: null, scope: null, exclusions: null, source_message_ids: [] };
}
