import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  actorCoversHouses,
  actorSeesAnyHouse,
  isMissingDispatchRelation,
  type DispatchActor,
} from "@/lib/vendor-dispatch/access.server";
import {
  parseDispatchRuleInput,
  type DispatchHours,
  type DispatchMode,
  type DispatchPropertyScope,
  type DispatchRule,
  type DispatchRuleInput,
  type DispatchRuleVendor,
} from "@/lib/vendor-dispatch/rules";
import type { DispatchUrgency } from "@/lib/vendor-dispatch/trades";
import type { VendorPayModel } from "@/lib/vendor-dispatch/vendor-roles";
import { isVendorCategorySettingsRow } from "@/lib/manager-vendors-storage";

/**
 * Dispatch rule CRUD (vendor-dispatch-1018). Every id in a body is checked
 * against the workspace re-derived from the session: a vendor must be a roster
 * row of the workspace owner, a house must belong to the workspace. Ids in a
 * request body are never authorization.
 */
export type RuleResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500 | 503; error: string };

type RuleRow = {
  id: string;
  workspace_id: string;
  name: string;
  trade: string;
  issue: string | null;
  property_scope: DispatchPropertyScope;
  property_ids: string[] | null;
  urgencies: string[] | null;
  hours: DispatchHours;
  mode: DispatchMode;
  broadcast_size: number;
  timeout_minutes: number | null;
  pay_cents: number | null;
  pay_model: VendorPayModel;
  nte_cents: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const RULE_COLUMNS =
  "id, workspace_id, name, trade, issue, property_scope, property_ids, urgencies, hours, mode, broadcast_size, timeout_minutes, pay_cents, pay_model, nte_cents, active, created_at, updated_at";

function covers(rule: Pick<DispatchRuleInput, "propertyScope" | "propertyIds">) {
  return rule.propertyScope === "all"
    ? ({ scope: "all" } as const)
    : ({ scope: "selected", propertyIds: rule.propertyIds } as const);
}

function toRule(row: RuleRow, vendors: DispatchRuleVendor[]): DispatchRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    trade: row.trade,
    issue: row.issue,
    propertyScope: row.property_scope,
    propertyIds: row.property_ids ?? [],
    urgencies: (row.urgencies ?? []) as DispatchUrgency[],
    hours: row.hours,
    mode: row.mode,
    broadcastSize: row.broadcast_size,
    timeoutMinutes: row.timeout_minutes,
    payCents: row.pay_cents,
    payModel: row.pay_model,
    nteCents: row.nte_cents,
    active: row.active,
    vendors,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadChains(
  db: SupabaseClient,
  ruleIds: readonly string[],
): Promise<Map<string, DispatchRuleVendor[]> | null> {
  const chains = new Map<string, DispatchRuleVendor[]>();
  if (ruleIds.length === 0) return chains;
  const { data, error } = await db
    .from("vendor_dispatch_rule_vendors")
    .select("rule_id, vendor_directory_id, position")
    .in("rule_id", [...ruleIds])
    .order("position", { ascending: true });
  if (error) return null;
  const vendorIds = [...new Set((data ?? []).map((row) => String(row.vendor_directory_id)))];
  const names = new Map<string, string>();
  if (vendorIds.length > 0) {
    const { data: vendorRows } = await db.from("manager_vendor_records").select("id, row_data").in("id", vendorIds);
    for (const row of vendorRows ?? []) {
      const name = String((row.row_data as { name?: string } | null)?.name ?? "").trim();
      names.set(String(row.id), name || "Vendor");
    }
  }
  for (const row of data ?? []) {
    const list = chains.get(String(row.rule_id)) ?? [];
    list.push({
      vendorDirectoryId: String(row.vendor_directory_id),
      position: Number(row.position),
      name: names.get(String(row.vendor_directory_id)) ?? "Vendor",
    });
    chains.set(String(row.rule_id), list);
  }
  return chains;
}

/** The workspace's rules the actor may see, newest first. An absent table reads as no rules. */
export async function listDispatchRules(db: SupabaseClient, actor: DispatchActor): Promise<RuleResult<DispatchRule[]>> {
  const { data, error } = await db
    .from("vendor_dispatch_rules")
    .select(RULE_COLUMNS)
    .eq("workspace_id", actor.workspace.id)
    .eq("owner_user_id", actor.ownerUserId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingDispatchRelation(error)) return { ok: true, value: [] };
    return { ok: false, status: 500, error: "Could not load dispatch rules." };
  }
  const rows = ((data ?? []) as RuleRow[]).filter((row) =>
    actorSeesAnyHouse(actor, row.property_scope === "all" ? { scope: "all" } : { scope: "selected", propertyIds: row.property_ids ?? [] }),
  );
  const chains = await loadChains(db, rows.map((row) => row.id));
  if (!chains) return { ok: false, status: 500, error: "Could not load dispatch rules." };
  return { ok: true, value: rows.map((row) => toRule(row, chains.get(row.id) ?? [])) };
}

/** Refuse a vendor that is not a roster row of the owner, or a house outside the workspace. */
export async function validateRuleReferences(
  db: SupabaseClient,
  actor: DispatchActor,
  input: DispatchRuleInput,
): Promise<RuleResult<null>> {
  const houses = new Set(actor.workspace.propertyIds.map(String));
  if (input.propertyIds.some((id) => !houses.has(id))) {
    return { ok: false, status: 403, error: "One of those houses is not in this workspace." };
  }
  if (input.vendorIds.some((id) => isVendorCategorySettingsRow({ id, name: "" }))) {
    return { ok: false, status: 403, error: "One of those vendors is not on your roster." };
  }
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("manager_user_id", actor.ownerUserId)
    .in("id", input.vendorIds);
  if (error) return { ok: false, status: 500, error: "Could not verify the vendors." };
  const found = new Set((data ?? []).map((row) => String(row.id)));
  if (input.vendorIds.some((id) => !found.has(id))) {
    return { ok: false, status: 403, error: "One of those vendors is not on your roster." };
  }
  if (!actorCoversHouses(actor, covers(input))) {
    return { ok: false, status: 403, error: "You do not have Services access on those houses." };
  }
  return { ok: true, value: null };
}

async function writeChain(db: SupabaseClient, ruleId: string, vendorIds: readonly string[]): Promise<boolean> {
  const rows = vendorIds.map((vendorId, position) => ({ rule_id: ruleId, vendor_directory_id: vendorId, position }));
  const { error } = await db.from("vendor_dispatch_rule_vendors").insert(rows);
  return !error;
}

function ruleColumnsFromInput(input: DispatchRuleInput) {
  return {
    name: input.name,
    trade: input.trade,
    issue: input.issue,
    property_scope: input.propertyScope,
    property_ids: input.propertyScope === "all" ? [] : input.propertyIds,
    urgencies: input.urgencies,
    hours: input.hours,
    mode: input.mode,
    broadcast_size: input.broadcastSize,
    timeout_minutes: input.timeoutMinutes,
    pay_cents: input.payCents,
    pay_model: input.payModel,
    nte_cents: input.nteCents,
    approval: "always",
    active: input.active,
  };
}

export async function createDispatchRule(
  db: SupabaseClient,
  actor: DispatchActor,
  raw: unknown,
): Promise<RuleResult<DispatchRule>> {
  const parsed = parseDispatchRuleInput(raw);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const checked = await validateRuleReferences(db, actor, parsed.value);
  if (!checked.ok) return checked;

  const { data, error } = await db
    .from("vendor_dispatch_rules")
    .insert({
      ...ruleColumnsFromInput(parsed.value),
      workspace_id: actor.workspace.id,
      owner_user_id: actor.ownerUserId,
    })
    .select(RULE_COLUMNS)
    .single();
  if (error || !data) {
    if (isMissingDispatchRelation(error)) return { ok: false, status: 503, error: "Dispatch is not available yet." };
    return { ok: false, status: 500, error: "Could not save the rule." };
  }
  const row = data as RuleRow;
  if (!(await writeChain(db, row.id, parsed.value.vendorIds))) {
    await db.from("vendor_dispatch_rules").delete().eq("id", row.id);
    return { ok: false, status: 500, error: "Could not save the rule." };
  }
  const chains = await loadChains(db, [row.id]);
  return { ok: true, value: toRule(row, chains?.get(row.id) ?? []) };
}

/** Load a stored rule in the actor's workspace; 404 for another workspace's id. */
async function loadOwnedRule(
  db: SupabaseClient,
  actor: DispatchActor,
  ruleId: string,
): Promise<RuleResult<{ row: RuleRow; vendorIds: string[] }>> {
  if (!/^[0-9a-f-]{36}$/i.test(ruleId)) return { ok: false, status: 404, error: "Rule not found." };
  const { data, error } = await db
    .from("vendor_dispatch_rules")
    .select(RULE_COLUMNS)
    .eq("id", ruleId)
    .eq("workspace_id", actor.workspace.id)
    .eq("owner_user_id", actor.ownerUserId)
    .maybeSingle();
  if (error) {
    if (isMissingDispatchRelation(error)) return { ok: false, status: 404, error: "Rule not found." };
    return { ok: false, status: 500, error: "Could not load the rule." };
  }
  if (!data) return { ok: false, status: 404, error: "Rule not found." };
  const row = data as RuleRow;
  const { data: chain } = await db
    .from("vendor_dispatch_rule_vendors")
    .select("vendor_directory_id, position")
    .eq("rule_id", row.id)
    .order("position", { ascending: true });
  return { ok: true, value: { row, vendorIds: (chain ?? []).map((entry) => String(entry.vendor_directory_id)) } };
}

function storedRuleCovers(row: RuleRow) {
  return row.property_scope === "all"
    ? ({ scope: "all" } as const)
    : ({ scope: "selected", propertyIds: row.property_ids ?? [] } as const);
}

export async function updateDispatchRule(
  db: SupabaseClient,
  actor: DispatchActor,
  ruleId: string,
  raw: unknown,
): Promise<RuleResult<DispatchRule>> {
  const loaded = await loadOwnedRule(db, actor, ruleId);
  if (!loaded.ok) return loaded;
  const { row, vendorIds } = loaded.value;
  // A rule the actor cannot reach reads as not found, never as forbidden.
  if (!actorSeesAnyHouse(actor, storedRuleCovers(row))) return { ok: false, status: 404, error: "Rule not found." };
  if (!actorCoversHouses(actor, storedRuleCovers(row))) {
    return { ok: false, status: 403, error: "You do not have Services access on those houses." };
  }
  const base: DispatchRuleInput = {
    name: row.name,
    trade: row.trade,
    issue: row.issue,
    propertyScope: row.property_scope,
    propertyIds: row.property_ids ?? [],
    urgencies: (row.urgencies ?? []) as DispatchUrgency[],
    hours: row.hours,
    mode: row.mode,
    broadcastSize: row.broadcast_size,
    timeoutMinutes: row.timeout_minutes,
    payCents: row.pay_cents,
    payModel: row.pay_model,
    nteCents: row.nte_cents,
    vendorIds,
    active: row.active,
  };
  const parsed = parseDispatchRuleInput(raw, base);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const checked = await validateRuleReferences(db, actor, parsed.value);
  if (!checked.ok) return checked;

  const { data, error } = await db
    .from("vendor_dispatch_rules")
    .update({ ...ruleColumnsFromInput(parsed.value), updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("workspace_id", actor.workspace.id)
    .select(RULE_COLUMNS)
    .maybeSingle();
  if (error || !data) return { ok: false, status: 500, error: "Could not save the rule." };

  const chainChanged =
    vendorIds.length !== parsed.value.vendorIds.length || vendorIds.some((id, index) => id !== parsed.value.vendorIds[index]);
  if (chainChanged) {
    const cleared = await db.from("vendor_dispatch_rule_vendors").delete().eq("rule_id", row.id);
    if (cleared.error || !(await writeChain(db, row.id, parsed.value.vendorIds))) {
      // Put the old chain back so a half-saved rule never loses its vendors.
      await db.from("vendor_dispatch_rule_vendors").delete().eq("rule_id", row.id);
      await writeChain(db, row.id, vendorIds);
      return { ok: false, status: 500, error: "Could not save the rule." };
    }
  }
  const chains = await loadChains(db, [row.id]);
  return { ok: true, value: toRule(data as RuleRow, chains?.get(row.id) ?? []) };
}

export async function deleteDispatchRule(
  db: SupabaseClient,
  actor: DispatchActor,
  ruleId: string,
): Promise<RuleResult<null>> {
  const loaded = await loadOwnedRule(db, actor, ruleId);
  if (!loaded.ok) return loaded;
  const { row } = loaded.value;
  if (!actorSeesAnyHouse(actor, storedRuleCovers(row))) return { ok: false, status: 404, error: "Rule not found." };
  if (!actorCoversHouses(actor, storedRuleCovers(row))) {
    return { ok: false, status: 403, error: "You do not have Services access on those houses." };
  }
  const { error } = await db
    .from("vendor_dispatch_rules")
    .delete()
    .eq("id", row.id)
    .eq("workspace_id", actor.workspace.id);
  if (error) return { ok: false, status: 500, error: "Could not delete the rule." };
  return { ok: true, value: null };
}
