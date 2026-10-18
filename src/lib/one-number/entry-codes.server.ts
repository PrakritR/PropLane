import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import {
  entryCodeCallToAction,
  entryCodeCandidates,
  entryCodeSmsLink,
  validateEntryCode,
  type EntryCodeProblem,
} from "@/lib/one-number/entry-codes";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";

/** At most this many live codes per house: a flyer, a sign, a listing. More is a typo loop. */
export const MAX_ACTIVE_CODES_PER_PROPERTY = 5;

export type EntryCodeRecord = {
  code: string;
  workspaceId: string;
  propertyId: string;
  label: string;
  active: boolean;
  createdAt: string;
};

export type EntryCodeError = EntryCodeProblem | "taken" | "property_not_found" | "too_many" | "not_found" | "unavailable";

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());

function toRecord(row: Row): EntryCodeRecord {
  return {
    code: str(row.code),
    workspaceId: str(row.workspace_id),
    propertyId: str(row.property_id),
    label: str(row.label),
    active: row.active !== false,
    createdAt: str(row.created_at),
  };
}

/**
 * The house, only if it is this workspace's own. A property id from a request proves nothing: the row
 * must name the workspace (or, for a legacy unstamped row, its owner) and the workspace must hold it.
 */
async function loadWorkspaceHouse(
  db: SupabaseClient,
  scope: { workspaceId: string; ownerUserId: string },
  propertyId: string,
): Promise<{ id: string; label: string; address: string } | null> {
  if (!propertyId) return null;
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, workspace_id, manager_user_id, property_data, row_data")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Row;
  const stamped = str(row.workspace_id);
  const inWorkspace = stamped ? stamped === scope.workspaceId : str(row.manager_user_id) === scope.ownerUserId;
  if (!inWorkspace || str(row.manager_user_id) !== scope.ownerUserId) return null;
  const pd = row.property_data && typeof row.property_data === "object" ? (row.property_data as Row) : {};
  const rd = row.row_data && typeof row.row_data === "object" ? (row.row_data as Row) : {};
  return { id: str(row.id), label: propertyLabel(pd) || propertyLabel(rd), address: str(pd.address) || str(rd.address) };
}

/** A code for a house that no other house holds yet (globally unique), or null when every candidate is taken. */
export async function suggestEntryCode(
  db: SupabaseClient,
  scope: { workspaceId: string; ownerUserId: string },
  propertyId: string,
): Promise<string | null> {
  const house = await loadWorkspaceHouse(db, scope, propertyId);
  if (!house) return null;
  const candidates = entryCodeCandidates({ address: house.address, label: house.label });
  if (candidates.length === 0) return null;
  const { data, error } = await db.from("sms_entry_codes").select("code").in("code", candidates);
  if (error) return null;
  const taken = new Set(((data ?? []) as Row[]).map((r) => str(r.code)));
  return candidates.find((c) => !taken.has(c)) ?? null;
}

/** Every code this workspace holds (optionally one house's). Another workspace's codes are never in the result. */
export async function listEntryCodes(
  db: SupabaseClient,
  scope: { workspaceId: string; propertyId?: string | null },
): Promise<EntryCodeRecord[]> {
  try {
    let query = db
      .from("sms_entry_codes")
      .select("code, workspace_id, property_id, label, active, created_at")
      .eq("workspace_id", scope.workspaceId);
    if (scope.propertyId) query = query.eq("property_id", scope.propertyId);
    const { data, error } = await query.order("created_at", { ascending: true });
    if (error) return [];
    return ((data ?? []) as Row[]).map(toRecord);
  } catch {
    return [];
  }
}

export async function createEntryCode(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    ownerUserId: string;
    actorUserId: string;
    propertyId: string;
    /** Omit to take the suggestion. */
    code?: string | null;
  },
): Promise<{ ok: true; record: EntryCodeRecord } | { ok: false; error: EntryCodeError }> {
  const scope = { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId };
  const house = await loadWorkspaceHouse(db, scope, input.propertyId);
  if (!house) return { ok: false, error: "property_not_found" };

  let code: string;
  if (input.code != null && String(input.code).trim() !== "") {
    const checked = validateEntryCode(input.code);
    if (!checked.ok) return checked;
    code = checked.code;
  } else {
    const suggested = await suggestEntryCode(db, scope, input.propertyId);
    if (!suggested) return { ok: false, error: "taken" };
    code = suggested;
  }

  const existing = await listEntryCodes(db, { workspaceId: input.workspaceId, propertyId: input.propertyId });
  if (existing.filter((c) => c.active).length >= MAX_ACTIVE_CODES_PER_PROPERTY) return { ok: false, error: "too_many" };

  const row = {
    code,
    workspace_id: input.workspaceId,
    owner_user_id: input.ownerUserId,
    property_id: input.propertyId,
    label: house.label || null,
    active: true,
    created_by: input.actorUserId,
  };
  const { error } = await db.from("sms_entry_codes").insert(row);
  if (error) {
    if (error.code === "23505") return { ok: false, error: "taken" };
    return { ok: false, error: "unavailable" };
  }
  return {
    ok: true,
    record: { code, workspaceId: input.workspaceId, propertyId: input.propertyId, label: house.label, active: true, createdAt: new Date().toISOString() },
  };
}

/**
 * Turn a code on or off. The row must belong to the caller's workspace: another workspace's code reads as
 * "not found", exactly like a code that does not exist, so a code can never be probed across teams.
 */
export async function setEntryCodeActive(
  db: SupabaseClient,
  input: { workspaceId: string; code: string; active: boolean; /** A co-manager only reaches the houses they hold. Omit for the whole workspace. */ allowedPropertyIds?: string[] },
): Promise<{ ok: true; record: EntryCodeRecord } | { ok: false; error: EntryCodeError }> {
  const code = input.code.trim().toUpperCase();
  if (!code) return { ok: false, error: "not_found" };
  const { data, error } = await db
    .from("sms_entry_codes")
    .select("code, workspace_id, property_id, label, active, created_at")
    .eq("code", code)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (error) return { ok: false, error: "unavailable" };
  if (!data) return { ok: false, error: "not_found" };
  const current = toRecord(data as Row);
  if (input.allowedPropertyIds && !input.allowedPropertyIds.includes(current.propertyId)) return { ok: false, error: "not_found" };
  if (current.active === input.active) return { ok: true, record: current };
  if (input.active) {
    const siblings = await listEntryCodes(db, { workspaceId: input.workspaceId, propertyId: current.propertyId });
    if (siblings.filter((c) => c.active).length >= MAX_ACTIVE_CODES_PER_PROPERTY) return { ok: false, error: "too_many" };
  }
  const { error: updateError } = await db
    .from("sms_entry_codes")
    .update({ active: input.active, updated_at: new Date().toISOString() })
    .eq("code", code)
    .eq("workspace_id", input.workspaceId);
  if (updateError) return { ok: false, error: "unavailable" };
  return { ok: true, record: { ...current, active: input.active } };
}

/**
 * The live entry code a house's door card may print, with its call to action and prefilled-text link, or null
 * (per-workspace line, no shared number, no live code). The caller has already authorized the manager for the
 * house; the row must name that house's owner too.
 */
export async function loadDoorCardTextCode(
  db: SupabaseClient,
  house: { propertyId: string; ownerUserId: string },
): Promise<{ code: string; callToAction: string; smsLink: string } | null> {
  try {
    const config = await loadSharedLineConfig(db);
    if (config.mode === "per_workspace" || !config.sharedNumber) return null;
    const { data, error } = await db
      .from("sms_entry_codes")
      .select("code, owner_user_id")
      .eq("property_id", house.propertyId)
      .eq("owner_user_id", house.ownerUserId)
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1);
    const row = (data ?? [])[0] as Row | undefined;
    if (error || !row) return null;
    const code = str(row.code);
    const callToAction = entryCodeCallToAction(code, config.sharedNumber);
    const smsLink = entryCodeSmsLink(code, config.sharedNumber);
    return callToAction && smsLink ? { code, callToAction, smsLink } : null;
  } catch {
    return null;
  }
}
