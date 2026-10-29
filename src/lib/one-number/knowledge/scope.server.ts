import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { resolveResidentForwardHouseId } from "@/lib/sms/inbound-forward-team.server";
import { houseInfoWithoutInternal, normalizeHouseInfo, type HouseInfoV1 } from "@/lib/house-info";
import { listingRoomSecretValues } from "@/lib/manager-listing-submission";
import { residentCheckInReveal } from "@/lib/check-in.server";
import type { KnowledgeScopeResult } from "./types";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type PropertyBrief = {
  id: string;
  workspaceId: string | null;
  label: string;
  houseInfo: HouseInfoV1;
  /** Each room's structured door code - secrets that live outside `houseInfo` and must never travel as text. */
  roomSecrets: string[];
};

/** Pull the structured house details out of a property record (listing submission). */
export function propertyBriefFromRow(row: Record<string, unknown>): PropertyBrief {
  const propertyData = asObject(row.property_data);
  const rowData = asObject(row.row_data);
  const submission = asObject(propertyData?.listingSubmission) ?? asObject(rowData?.submission);
  const label =
    asText(propertyData?.title) ||
    asText(propertyData?.buildingName) ||
    asText(rowData?.buildingName) ||
    asText(submission?.buildingName) ||
    asText(propertyData?.address) ||
    asText(rowData?.address) ||
    asText(submission?.address) ||
    String(row.id ?? "");
  return {
    id: String(row.id ?? ""),
    workspaceId: row.workspace_id ? String(row.workspace_id) : null,
    label,
    // The staff-only Internal section is never part of a brief an assistant answers from.
    houseInfo: houseInfoWithoutInternal(normalizeHouseInfo(submission?.houseInfo)),
    roomSecrets: listingRoomSecretValues(submission as { rooms?: ReadonlyArray<{ doorCode?: string | null }> | null } | null),
  };
}

/** A property of THIS owner, or null. The id may come from a model, so ownership is re-checked here. */
export async function loadOwnedProperty(db: SupabaseClient, ownerUserId: string, propertyId: string): Promise<PropertyBrief | null> {
  const id = propertyId.trim();
  if (!id || !ownerUserId.trim()) return null;
  try {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, workspace_id, property_data, row_data")
      .eq("id", id)
      .eq("manager_user_id", ownerUserId)
      .maybeSingle();
    if (error || !data) return null;
    return propertyBriefFromRow(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function loadWorkspaceProperties(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string,
  onlyIds?: readonly string[] | null,
): Promise<PropertyBrief[]> {
  try {
    let query = db
      .from("manager_property_records")
      .select("id, workspace_id, property_data, row_data")
      .eq("manager_user_id", ownerUserId)
      .eq("workspace_id", workspaceId)
      .limit(60);
    if (onlyIds) query = query.in("id", [...onlyIds]);
    const { data, error } = await query;
    if (error) return [];
    return ((data ?? []) as Record<string, unknown>[]).map(propertyBriefFromRow);
  } catch {
    return [];
  }
}

async function ownerWorkspaces(db: SupabaseClient, ownerUserId: string): Promise<{ id: string; isDefault: boolean }[]> {
  try {
    const { data, error } = await db
      .from("portal_workspaces")
      .select("id, is_default")
      .eq("owner_user_id", ownerUserId);
    if (error) return [];
    return ((data ?? []) as { id: string; is_default: boolean }[]).map((w) => ({ id: String(w.id), isDefault: Boolean(w.is_default) }));
  } catch {
    return [];
  }
}

/**
 * The workspace a non-manager turn reads. A verified house names it; otherwise it is the owner's
 * ONLY workspace. An owner with several workspaces and no house is ambiguous, and an ambiguous
 * scope reads nothing rather than guess a team.
 */
async function workspaceForOwner(
  db: SupabaseClient,
  ownerUserId: string,
  property: PropertyBrief | null,
): Promise<{ ok: true; workspaceId: string } | { ok: false; reason: "needs_house" | "unresolved" }> {
  if (property?.workspaceId) return { ok: true, workspaceId: property.workspaceId };
  const all = await ownerWorkspaces(db, ownerUserId);
  if (all.length === 0) return { ok: false, reason: "unresolved" };
  if (all.length === 1) return { ok: true, workspaceId: all[0]!.id };
  return { ok: false, reason: "needs_house" };
}

/** Manager (portal or SMS): the active workspace, narrowed by co-manager assignment. */
export function resolveManagerKnowledgeScope(
  ctx: AgentContext,
  inputPropertyId: string | null,
  defaultWorkspaceId: string | null,
): KnowledgeScopeResult {
  if (ctx.workspace && ctx.workspace.id.trim() === "") return { ok: false, reason: "unresolved" };
  const workspaceId = ctx.workspace?.id || defaultWorkspaceId || "";
  if (!workspaceId) return { ok: false, reason: "unresolved" };
  const ownerUserId = ctx.managerSmsAccess?.workNumberOwnerId ?? ctx.landlordId;
  let allowed: readonly string[] | null = ctx.workspace ? ctx.workspace.propertyIds : null;
  if (ctx.managerSmsAccess?.mode === "delegated") {
    const assigned = new Set(ctx.managerSmsAccess.assignedPropertyIds);
    allowed = (allowed ?? [...assigned]).filter((id) => assigned.has(id));
  }
  const focus = inputPropertyId && (!allowed || allowed.includes(inputPropertyId)) ? inputPropertyId : null;
  return {
    ok: true,
    scope: {
      viewer: "manager",
      workspaceId,
      ownerUserId,
      allowedPropertyIds: allowed,
      focusPropertyId: focus,
      audiences: ["all", "residents", "team"],
      includeHouseInfo: true,
      includeHouseSecrets: true,
    },
  };
}

/** Prospect on a work number: only entries marked for everyone, never house details. */
export async function resolveLeasingKnowledgeScope(
  db: SupabaseClient,
  ctx: AgentContext,
  inputPropertyId: string | null,
): Promise<KnowledgeScopeResult> {
  // The shared catalog line fronts every manager, so there is no single owner to read for.
  if (!ctx.leasingScope || ctx.leasingScope.crossCatalog) return { ok: false, reason: "not_available" };
  const property = inputPropertyId ? await loadOwnedProperty(db, ctx.landlordId, inputPropertyId) : null;
  const ws = await workspaceForOwner(db, ctx.landlordId, property);
  if (!ws.ok) return ws;
  return {
    ok: true,
    scope: {
      viewer: "prospect",
      workspaceId: ws.workspaceId,
      ownerUserId: ctx.landlordId,
      allowedPropertyIds: property ? [property.id] : [],
      focusPropertyId: property?.id ?? null,
      audiences: ["all"],
      includeHouseInfo: false,
      includeHouseSecrets: false,
    },
  };
}

/** Vendor on a job: only entries marked for everyone, about the job's own house. */
export async function resolveVendorKnowledgeScope(db: SupabaseClient, ctx: AgentContext): Promise<KnowledgeScopeResult> {
  const scope = ctx.vendorScope;
  if (!scope) return { ok: false, reason: "not_available" };
  let propertyId = "";
  try {
    const { data } = await db
      .from("portal_work_order_records")
      .select("row_data")
      .eq("id", scope.workOrderId)
      .eq("manager_user_id", ctx.landlordId)
      .maybeSingle();
    const row = asObject((data as { row_data?: unknown } | null)?.row_data);
    propertyId = asText(row?.assignedPropertyId) || asText(row?.propertyId);
  } catch {
    propertyId = "";
  }
  const property = propertyId ? await loadOwnedProperty(db, ctx.landlordId, propertyId) : null;
  const ws = await workspaceForOwner(db, ctx.landlordId, property);
  if (!ws.ok) return ws;
  return {
    ok: true,
    scope: {
      viewer: "vendor",
      workspaceId: ws.workspaceId,
      ownerUserId: ctx.landlordId,
      allowedPropertyIds: property ? [property.id] : [],
      focusPropertyId: property?.id ?? null,
      audiences: ["all"],
      includeHouseInfo: false,
      includeHouseSecrets: false,
    },
  };
}

/**
 * Resident: their lease's house; entries for everyone and for residents. House details only on the
 * same terms as `get_move_in_info` (approved stage and no unsubmitted blocking form), and its SECRETS
 * only once the check-in reveal has opened: no door code, Wi-Fi password or free-text access note
 * before 24 hours ahead of move-in (`checkInReveal`). Trash day, the rules and the rest of the brief
 * are not codes and are not withheld with them - the same split `get_move_in_info` makes.
 */
export async function resolveResidentKnowledgeScope(db: SupabaseClient, ctx: ResidentAgentContext): Promise<KnowledgeScopeResult> {
  const owners = ctx.activeManagerId ? [ctx.activeManagerId] : [...new Set(ctx.managerIds)];
  // A portal resident with several managers has no single team to read for.
  if (owners.length !== 1) return { ok: false, reason: "needs_house" };
  const ownerUserId = owners[0]!;
  const houseId = await resolveResidentForwardHouseId(db, { ownerManagerUserId: ownerUserId, residentEmail: ctx.email });
  const property = houseId ? await loadOwnedProperty(db, ownerUserId, houseId) : null;
  const ws = await workspaceForOwner(db, ownerUserId, property);
  if (!ws.ok) return ws;
  const approved = ctx.phase === "approved";
  const revealed =
    Boolean(property) && approved && ctx.moveInDetailsLocked === false
      ? (await residentCheckInReveal(db, ctx.email, { managerUserId: ownerUserId, leaseUnlocked: true })).revealed
      : false;
  return {
    ok: true,
    scope: {
      viewer: "resident",
      workspaceId: ws.workspaceId,
      ownerUserId,
      allowedPropertyIds: property ? [property.id] : [],
      focusPropertyId: property?.id ?? null,
      audiences: approved ? ["all", "residents"] : ["all"],
      includeHouseInfo: Boolean(property) && approved && ctx.moveInDetailsLocked === false,
      includeHouseSecrets: revealed,
    },
  };
}

export async function defaultWorkspaceIdFor(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  const all = await ownerWorkspaces(db, ownerUserId);
  return all.find((w) => w.isDefault)?.id ?? (all.length === 1 ? all[0]!.id : null);
}

/**
 * The workspace a work number answers for: the number's home workspace, else the owner's only or
 * default workspace. Used where a reply path knows the line but not the workspace.
 */
export async function workspaceForWorkNumber(
  db: SupabaseClient,
  ownerUserId: string,
  workNumber: string | null | undefined,
): Promise<string | null> {
  const number = workNumber?.trim();
  if (number) {
    try {
      const { data } = await db
        .from("manager_sms_numbers")
        .select("workspace_id")
        .eq("manager_user_id", ownerUserId)
        .eq("phone_number", number)
        .maybeSingle();
      const id = (data as { workspace_id?: string | null } | null)?.workspace_id;
      if (id) return String(id);
    } catch {
      /* fall through to the owner's default */
    }
  }
  return defaultWorkspaceIdFor(db, ownerUserId);
}
