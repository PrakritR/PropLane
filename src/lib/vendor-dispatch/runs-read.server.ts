import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { actorSeesAnyHouse, isMissingDispatchRelation, type DispatchActor } from "@/lib/vendor-dispatch/access.server";
import {
  asAttemptStatus,
  asRunStatus,
  type DispatchAttemptView,
  type DispatchRunView,
} from "@/lib/vendor-dispatch/runs-view";

/**
 * Read side of dispatch runs for the portal (vendor-dispatch-1018). The engine
 * writes runs and attempts (`runs.server.ts`); this only reads them, scoped to
 * the workspace and owner re-derived from the session. A co-manager sees a run
 * only when the Services module is granted on its house; a run with no house is
 * the owner's alone.
 */
type RunRow = {
  id: string;
  handle: number;
  source_type: string;
  source_id: string;
  trade: string;
  issue: string | null;
  urgency: string;
  property_id: string | null;
  offer_text: string | null;
  mode: "sequential" | "broadcast";
  pay_cents: number | null;
  nte_cents: number | null;
  status: string;
  approval_channel: "sms" | "portal" | null;
  approved_by: string | null;
  approved_at: string | null;
  accepted_vendor_directory_id: string | null;
  accepted_at: string | null;
  scheduled_for: string | null;
  workspace_id: string;
  owner_user_id: string;
  created_at: string;
};

const RUN_COLUMNS =
  "id, handle, source_type, source_id, trade, issue, urgency, property_id, offer_text, mode, pay_cents, nte_cents, status, approval_channel, approved_by, approved_at, accepted_vendor_directory_id, accepted_at, scheduled_for, workspace_id, owner_user_id, created_at";

export function actorMaySeeRun(actor: DispatchActor, run: Pick<RunRow, "property_id">): boolean {
  if (actor.grantedPropertyIds === null) return true;
  const propertyId = run.property_id?.trim();
  if (!propertyId) return false;
  return actorSeesAnyHouse(actor, { scope: "selected", propertyIds: [propertyId] });
}

async function vendorNames(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data } = await db.from("manager_vendor_records").select("id, row_data").in("id", [...ids]);
  for (const row of data ?? []) {
    const name = String((row.row_data as { name?: string } | null)?.name ?? "").trim();
    names.set(String(row.id), name || "Vendor");
  }
  return names;
}

async function approverNames(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data } = await db.from("profiles").select("id, full_name, email").in("id", [...ids]);
  for (const row of data ?? []) {
    const name = String(row.full_name ?? "").trim() || String(row.email ?? "").trim();
    if (name) names.set(String(row.id), name);
  }
  return names;
}

export type RunQuery = {
  sourceType?: string | null;
  sourceId?: string | null;
  status?: string | null;
  runId?: string | null;
};

export async function listDispatchRuns(
  db: SupabaseClient,
  actor: DispatchActor,
  query: RunQuery,
): Promise<{ ok: true; runs: DispatchRunView[] } | { ok: false; status: number; error: string }> {
  let builder = db
    .from("vendor_dispatch_runs")
    .select(RUN_COLUMNS)
    .eq("workspace_id", actor.workspace.id)
    .eq("owner_user_id", actor.ownerUserId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (query.runId) builder = builder.eq("id", query.runId);
  if (query.sourceType) builder = builder.eq("source_type", query.sourceType);
  if (query.sourceId) builder = builder.eq("source_id", query.sourceId);
  if (query.status) builder = builder.eq("status", query.status);
  const { data, error } = await builder;
  if (error) {
    if (isMissingDispatchRelation(error)) return { ok: true, runs: [] };
    return { ok: false, status: 500, error: "Could not load dispatch." };
  }
  const rows = ((data ?? []) as RunRow[]).filter((row) => actorMaySeeRun(actor, row));
  if (rows.length === 0) return { ok: true, runs: [] };

  const { data: attemptData, error: attemptError } = await db
    .from("vendor_dispatch_attempts")
    .select("id, run_id, vendor_directory_id, position, wave, status, offered_at, responded_at, response_text")
    .in("run_id", rows.map((row) => row.id))
    .order("wave", { ascending: true })
    .order("position", { ascending: true });
  if (attemptError && !isMissingDispatchRelation(attemptError)) return { ok: false, status: 500, error: "Could not load dispatch." };
  const attempts = attemptData ?? [];

  const vendorIds = [
    ...new Set([
      ...attempts.map((attempt) => String(attempt.vendor_directory_id)),
      ...rows.map((row) => row.accepted_vendor_directory_id).filter((id): id is string => Boolean(id)),
    ]),
  ];
  const approverIds = [...new Set(rows.map((row) => row.approved_by).filter((id): id is string => Boolean(id)))];
  const [vendors, approvers] = await Promise.all([vendorNames(db, vendorIds), approverNames(db, approverIds)]);

  const runs: DispatchRunView[] = rows.map((row) => {
    const mine: DispatchAttemptView[] = attempts
      .filter((attempt) => String(attempt.run_id) === row.id)
      .map((attempt) => ({
        id: String(attempt.id),
        vendorDirectoryId: String(attempt.vendor_directory_id),
        vendorName: vendors.get(String(attempt.vendor_directory_id)) ?? "Vendor",
        position: Number(attempt.position),
        wave: Number(attempt.wave ?? 0),
        status: asAttemptStatus(attempt.status),
        offeredAt: (attempt.offered_at as string | null) ?? null,
        respondedAt: (attempt.responded_at as string | null) ?? null,
        responseText: (attempt.response_text as string | null) ?? null,
      }));
    return {
      id: row.id,
      handle: Number(row.handle),
      sourceType: row.source_type,
      sourceId: row.source_id,
      trade: row.trade,
      issue: row.issue,
      urgency: row.urgency,
      propertyId: row.property_id,
      offerText: row.offer_text ?? "",
      mode: row.mode,
      payCents: row.pay_cents,
      nteCents: row.nte_cents,
      status: asRunStatus(row.status),
      approvalChannel: row.approval_channel,
      approvedByName: row.approved_by ? approvers.get(row.approved_by) ?? null : null,
      approvedAt: row.approved_at,
      acceptedVendorName: row.accepted_vendor_directory_id ? vendors.get(row.accepted_vendor_directory_id) ?? "Vendor" : null,
      acceptedAt: row.accepted_at,
      scheduledFor: row.scheduled_for,
      createdAt: row.created_at,
      attempts: mine,
    };
  });
  return { ok: true, runs };
}
