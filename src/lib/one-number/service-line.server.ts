import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError, loadSharedLineConfigStrict } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * The PropLane line for PropLane-MANAGED workspaces (captain, Oct 25: "anything under that management use main 206 number
 * now"). Every workspace carrying `portal_workspaces.is_service` texts on the PropLane line, in BOTH line modes, even when it
 * still holds a live `manager_sms_numbers` row of its own. This module is the ONE place that decides that:
 *
 *   shared mode                    the configured shared number (`sms_runtime_config.shared_number_e164`), no per-workspace row;
 *   per_workspace / shadow mode    the number the platform service owner holds, on the owner's DEFAULT workspace
 *                                  (the same line `isPropLaneServiceLine` recognises).
 *
 * Fail closed: a line that cannot be resolved is `no_service_line` (callers refuse with the existing
 * `workspace_has_no_work_number`) and one that cannot be READ is `unreadable`. Nothing here ever falls back to the
 * workspace's old number. Leaf module on purpose: the row resolver, the readiness gate and the resolvers all import it.
 */

export type ServiceLine<T = Record<string, unknown>> =
  | { ok: true; kind: "shared"; phoneNumber: string; messagingServiceSid: string | null }
  | { ok: true; kind: "owner_number"; phoneNumber: string; row: T; serviceOwnerUserId: string }
  | { ok: false; reason: "no_service_line" | "unreadable" };

/** Columns the resolution itself filters on; guaranteed present whatever the caller selects. */
function withLineColumns(columns: string): string {
  let out = columns;
  for (const required of ["released_at", "workspace_id", "manager_user_id", "phone_number"] as const) {
    if (!new RegExp(`(^|,)\\s*${required}\\s*(,|$)`).test(out)) out = `${out}, ${required}`;
  }
  return out;
}

/**
 * Is this workspace PropLane-managed? Null when that cannot be read (callers refuse: they cannot prove the workspace is NOT
 * managed). A database that predates the column reads as "not managed".
 */
export async function isServiceWorkspace(db: SupabaseClient, workspaceId: string | null | undefined): Promise<boolean | null> {
  const id = String(workspaceId ?? "").trim();
  if (!id) return false;
  try {
    const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", id).maybeSingle();
    if (error) return isMissingSchemaError(error) ? false : null;
    return (data as { is_service?: unknown } | null)?.is_service === true;
  } catch {
    return null;
  }
}

/** Which of these workspaces are PropLane-managed. Null when that cannot be read (a status screen then draws nothing managed). */
export async function loadManagedWorkspaceIds(db: SupabaseClient, workspaceIds: ReadonlyArray<string | null | undefined>): Promise<Set<string> | null> {
  const ids = [...new Set(workspaceIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return new Set();
  try {
    const { data, error } = await db.from("portal_workspaces").select("id, is_service").in("id", ids);
    if (error) return isMissingSchemaError(error) ? new Set() : null;
    return new Set(
      ((data ?? []) as Array<{ id?: unknown; is_service?: unknown }>)
        .filter((row) => row.is_service === true)
        .map((row) => String(row.id ?? "").trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

/** The platform service owner (`platform_service_settings`), or null when none is set. Throws when the read fails. */
export async function readServiceOwnerOrThrow(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  if (error) throw new Error(error.message || "platform service owner read failed");
  return String((data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "").trim() || null;
}

/**
 * The PropLane line a managed workspace sends on. `columns` is what the caller wants of the service owner's number row
 * (`kind: "owner_number"` only; the registration and provider checks stay with the caller).
 */
export async function resolveServiceLine<T = Record<string, unknown>>(db: SupabaseClient, columns = "phone_number"): Promise<ServiceLine<T>> {
  const config = await loadSharedLineConfigStrict(db);
  if (!config.ok) return { ok: false, reason: "unreadable" };
  if (config.config.mode === "shared" && config.config.sharedNumber) {
    return { ok: true, kind: "shared", phoneNumber: config.config.sharedNumber, messagingServiceSid: config.config.messagingServiceSid };
  }

  let serviceOwner: string | null;
  try {
    serviceOwner = await readServiceOwnerOrThrow(db);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!serviceOwner) return { ok: false, reason: "no_service_line" };

  const { data: def, error: defError } = await db
    .from("portal_workspaces")
    .select("id")
    .eq("owner_user_id", serviceOwner)
    .eq("is_default", true)
    .maybeSingle();
  if (defError) return { ok: false, reason: "unreadable" };
  const defaultWorkspaceId = String((def as { id?: unknown } | null)?.id ?? "").trim();

  const { data, error } = await db.from("manager_sms_numbers").select(withLineColumns(columns)).eq("manager_user_id", serviceOwner);
  if (error) return { ok: false, reason: "unreadable" };
  const rows = ((Array.isArray(data) ? data : data ? [data] : []) as unknown as Array<Record<string, unknown>>).filter(Boolean);
  const live = (list: Array<Record<string, unknown>>) => list.find((r) => !r.released_at && normalizeE164(String(r.phone_number ?? "")));
  // The owner's default workspace holds the PropLane line; a legacy row the migration could not place answers for that
  // workspace only. A released row is history and never the line.
  const home = defaultWorkspaceId ? live(rows.filter((r) => String(r.workspace_id ?? "") === defaultWorkspaceId)) : undefined;
  const row = home ?? live(rows.filter((r) => !String(r.workspace_id ?? "").trim()));
  const phoneNumber = row ? normalizeE164(String(row.phone_number ?? "")) : null;
  if (!row || !phoneNumber) return { ok: false, reason: "no_service_line" };
  return { ok: true, kind: "owner_number", phoneNumber, row: row as T, serviceOwnerUserId: serviceOwner };
}

/**
 * Which workspace a send is about, and whether it is PropLane-managed. Any of the workspace the caller names, the workspace
 * the pinned line belongs to, or the workspace that holds the house being managed makes the send a managed one (strictest
 * reading wins: a managed workspace's text never leaves on a number of its own). With no hint the owner's default workspace
 * is meant. `managed: null` = it could not be read; callers refuse.
 */
export async function resolveManagedSendTarget(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceIds?: ReadonlyArray<string | null | undefined>;
    propertyId?: string | null;
    workLineId?: string | null;
  },
): Promise<{ managed: boolean | null; workspaceId: string | null }> {
  const candidates: string[] = [];
  const add = (id: unknown) => {
    const value = String(id ?? "").trim();
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  (input.workspaceIds ?? []).forEach(add);
  try {
    const lineId = String(input.workLineId ?? "").trim();
    if (lineId) {
      const { data, error } = await db.from("manager_sms_numbers").select("workspace_id").eq("id", lineId).maybeSingle();
      if (error && !isMissingSchemaError(error)) return { managed: null, workspaceId: null };
      add((data as { workspace_id?: unknown } | null)?.workspace_id);
    }
    const propertyId = String(input.propertyId ?? "").trim();
    if (propertyId) {
      const { data, error } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
      if (error && !isMissingSchemaError(error)) return { managed: null, workspaceId: null };
      add((data as { workspace_id?: unknown } | null)?.workspace_id);
    }
    if (candidates.length === 0) {
      const owner = input.ownerUserId.trim();
      if (!owner) return { managed: false, workspaceId: null };
      const { data, error } = await db.from("portal_workspaces").select("id").eq("owner_user_id", owner).eq("is_default", true).maybeSingle();
      if (error) return { managed: null, workspaceId: null };
      add((data as { id?: unknown } | null)?.id);
    }
  } catch {
    return { managed: null, workspaceId: null };
  }
  let unreadable = false;
  for (const id of candidates) {
    const managed = await isServiceWorkspace(db, id);
    if (managed === true) return { managed: true, workspaceId: id };
    if (managed === null) unreadable = true;
  }
  if (unreadable) return { managed: null, workspaceId: candidates[0] ?? null };
  return { managed: false, workspaceId: candidates[0] ?? null };
}
