import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeAdminAuditReason } from "@/lib/admin-billing-audit.server";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { updateAuditResult, writeAuditLog } from "@/lib/tools/audit";
import { PROPLANE_LINE_MODES, type ProplaneLineMode } from "@/lib/service/proplane-line-shared";

/**
 * The PropLane line: the one shared number on the website that answers all housing, owned by the ADMIN account
 * (`sms_runtime_config.line_mode / shared_number_e164 / shared_pilot_workspace_ids`, one-number W1). This is the
 * only writer of those columns from the product. It never touches Twilio: it records which number the router and
 * transport should treat as the shared line and in what mode.
 *
 * A change is admin-only (the route's gate), needs a reason, and is audited BEFORE it is applied: if the audit row
 * cannot be written the change is refused, the way a "View as" session records itself before its cookie exists.
 */

export const PROPLANE_LINE_AUDIT_ACTION = "admin_proplane_line_change";
const MAX_PILOT_IDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProplaneLineState = {
  mode: ProplaneLineMode;
  sharedNumber: string | null;
  pilotWorkspaceIds: string[];
};

export type ProplaneLineRead =
  | { ok: true; configured: boolean; state: ProplaneLineState; lastChange: { at: string; reason: string; actorUserId: string } | null }
  | { ok: false; status: number; error: string };

const EMPTY: ProplaneLineState = { mode: "per_workspace", sharedNumber: null, pilotWorkspaceIds: [] };

async function readState(db: SupabaseClient): Promise<{ configured: boolean; state: ProplaneLineState } | null> {
  const { data, error } = await db
    .from("sms_runtime_config")
    .select("line_mode, shared_number_e164, shared_pilot_workspace_ids")
    .eq("singleton", true)
    .maybeSingle();
  if (error) {
    // The one-number migration has not run here: nothing to change, and nothing broken.
    if (isMissingSchemaError(error)) return { configured: false, state: EMPTY };
    return null;
  }
  if (!data) return { configured: false, state: EMPTY };
  const row = data as Record<string, unknown>;
  const mode = PROPLANE_LINE_MODES.find((m) => m === row.line_mode) ?? "per_workspace";
  const pilot = Array.isArray(row.shared_pilot_workspace_ids)
    ? row.shared_pilot_workspace_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  return {
    configured: true,
    state: { mode, sharedNumber: normalizeE164(row.shared_number_e164), pilotWorkspaceIds: pilot },
  };
}

export async function readProplaneLine(db: SupabaseClient): Promise<ProplaneLineRead> {
  const current = await readState(db);
  if (!current) return { ok: false, status: 503, error: "Could not load the PropLane line. Please retry." };
  let lastChange: { at: string; reason: string; actorUserId: string } | null = null;
  try {
    const { data } = await db
      .from("audit_log")
      .select("actor_user_id, input_summary, created_at")
      .eq("action", PROPLANE_LINE_AUDIT_ACTION)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = (data as Array<{ actor_user_id: string; input_summary: { reason?: unknown } | null; created_at: string }> | null)?.[0];
    if (row) lastChange = { at: row.created_at, reason: String(row.input_summary?.reason ?? ""), actorUserId: row.actor_user_id };
  } catch {
    lastChange = null;
  }
  return { ok: true, configured: current.configured, state: current.state, lastChange };
}

export type ProplaneLineChangeResult =
  | { ok: false; status: number; error: string }
  | { ok: true; state: ProplaneLineState };

export async function changeProplaneLine(
  db: SupabaseClient,
  actorUserId: string,
  input: { mode: unknown; sharedNumber: unknown; pilotWorkspaceIds: unknown; reason: unknown },
): Promise<ProplaneLineChangeResult> {
  const reason = normalizeAdminAuditReason(input.reason);
  if (!reason) return { ok: false, status: 400, error: "A reason is required." };

  const mode = PROPLANE_LINE_MODES.find((m) => m === input.mode);
  if (!mode) return { ok: false, status: 400, error: "Choose a line mode." };

  const rawNumber = typeof input.sharedNumber === "string" ? input.sharedNumber.trim() : input.sharedNumber;
  let sharedNumber: string | null = null;
  if (rawNumber !== null && rawNumber !== undefined && rawNumber !== "") {
    sharedNumber = normalizeE164(rawNumber);
    if (!sharedNumber) return { ok: false, status: 400, error: "Enter a valid phone number, like +12065550100." };
    // The database check is stricter than the normalizer (8-15 digits after the plus).
    if (!/^\+[1-9][0-9]{7,14}$/.test(sharedNumber)) return { ok: false, status: 400, error: "Enter a valid phone number, like +12065550100." };
  }
  if (mode === "shared" && !sharedNumber) return { ok: false, status: 400, error: "A shared line needs its number." };

  if (!Array.isArray(input.pilotWorkspaceIds)) return { ok: false, status: 400, error: "Workspaces must be a list." };
  const pilot = [...new Set(input.pilotWorkspaceIds.map((id) => (typeof id === "string" ? id.trim().toLowerCase() : "")))];
  if (pilot.length > MAX_PILOT_IDS || pilot.some((id) => !UUID.test(id))) {
    return { ok: false, status: 400, error: "Choose workspaces from the list." };
  }
  if (pilot.length > 0) {
    const found = await db.from("portal_workspaces").select("id").in("id", pilot);
    if (found.error) return { ok: false, status: 503, error: "Could not verify the workspaces. Please retry." };
    if (((found.data ?? []) as unknown[]).length !== pilot.length) {
      return { ok: false, status: 400, error: "Choose workspaces from the list." };
    }
  }

  const before = await readState(db);
  if (!before) return { ok: false, status: 503, error: "Could not load the PropLane line. Please retry." };
  if (!before.configured) return { ok: false, status: 409, error: "The shared line is not set up in this database yet." };
  const after: ProplaneLineState = { mode, sharedNumber, pilotWorkspaceIds: pilot };
  const same =
    before.state.mode === after.mode &&
    before.state.sharedNumber === after.sharedNumber &&
    [...before.state.pilotWorkspaceIds].sort().join(",") === [...after.pilotWorkspaceIds].sort().join(",");
  if (same) return { ok: false, status: 409, error: "Nothing changed." };

  // Audit first: no recorded reason, no change.
  const dedupeKey = `proplane-line:${actorUserId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const actor = { db, landlordId: actorUserId, userId: actorUserId };
  const audit = await writeAuditLog(actor, {
    action: PROPLANE_LINE_AUDIT_ACTION,
    toolName: PROPLANE_LINE_AUDIT_ACTION,
    inputSummary: { before: before.state, after, reason },
    resultSummary: { applied: false },
    dedupeKey,
  });
  if (!audit.recorded) return { ok: false, status: 503, error: "Could not record the change. Nothing was changed." };

  const written = await db
    .from("sms_runtime_config")
    .update({
      line_mode: after.mode,
      shared_number_e164: after.sharedNumber,
      shared_pilot_workspace_ids: after.pilotWorkspaceIds,
    })
    .eq("singleton", true)
    .select("singleton");
  if (written.error || !((written.data ?? []) as unknown[]).length) {
    await updateAuditResult(actor, dedupeKey, { applied: false, failed: true });
    return { ok: false, status: 503, error: "Could not save the PropLane line. Please retry." };
  }
  await updateAuditResult(actor, dedupeKey, { applied: true });
  return { ok: true, state: after };
}
