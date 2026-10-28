import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { ownerShareBpsForFeePercent, MANAGEMENT_FEE_RANGE_MESSAGE } from "@/lib/owner-management/fee-percent";
import { cleanOwnerOfRecord, cleanServiceCity } from "@/lib/service/service-input";
import { resolveServiceOwner } from "@/lib/service/service-owner.server";
import {
  attachWorkspaceToService,
  setServiceWorkspaceFee,
  SERVICE_NOT_CONFIGURED,
  type ServiceFailure,
  type ServiceResult,
} from "@/lib/service/service-workspaces.server";
import { updateAuditResult, writeAuditLog } from "@/lib/tools/audit";
import { isArchivedWorkspaceRow, isMissingArchivedColumn } from "@/lib/workspaces/archived";

/**
 * Admin > Accounts > Managers > "Managed by PropLane..." turns an owner's EXISTING workspaces into PropLane-managed
 * ones. It adds no new way to do that: every workspace goes through `attachWorkspaceToService` (a flag plus memberships;
 * the audit row is written first; `owner_user_id` never moves; the account stays the owner of record, view-only).
 *
 * "Combine all into one" moves the owner's OTHER workspaces' houses into ONE chosen workspace through
 * `combine_portal_workspaces` (one transaction: only `manager_property_records.workspace_id` changes - never an owner,
 * lease, charge or application - then the emptied workspaces are archived, reversibly), and attaches that workspace
 * afterwards. Each move is audited BEFORE anything changes, and every read that fails refuses the whole request with
 * nothing written. A refused move leaves every workspace unmanaged and listed, so the admin can simply try again.
 *
 * The caller proved the operator is a platform admin (`requireAdminRoute`); this layer re-derives that, the account's
 * workspaces and their houses from the database. A body id is a name, never a grant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ADMIN_SERVICE_COMBINE_MOVE_AUDIT_ACTION = "admin_service_combine_move";
export const MANAGED_BY_PROPLANE_REASON = "Managed by PropLane (Accounts > Managers)";

const fail = (status: number, error: string): ServiceFailure => ({ ok: false, status, error });

export type ManagedAccountWorkspace = {
  id: string;
  name: string;
  city: string | null;
  houseCount: number;
  isDefault: boolean;
};

type OwnedWorkspaceRow = { id: string; name: string; city: string | null; isDefault: boolean; isService: boolean };

/** The account's workspaces that are not archived. `null` when the read failed (the caller refuses; never "none"). */
async function readOwnedWorkspaces(db: SupabaseClient, accountUserId: string): Promise<OwnedWorkspaceRow[] | null> {
  const columns = "id, name, city, is_default, is_service";
  let res: { data: unknown; error: { code?: string } | null } = await db.from("portal_workspaces").select(`${columns}, archived_at`).eq("owner_user_id", accountUserId).order("created_at");
  if (res.error && isMissingArchivedColumn(res.error)) res = await db.from("portal_workspaces").select(columns).eq("owner_user_id", accountUserId).order("created_at");
  if (res.error) return null;
  return ((res.data ?? []) as Record<string, unknown>[])
    .filter((row) => !isArchivedWorkspaceRow(row))
    .map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      city: typeof row.city === "string" && row.city.trim() ? row.city : null,
      isDefault: row.is_default === true,
      isService: row.is_service === true,
    }));
}

/** workspace id -> the ids of the houses linked to it, for one owner. `null` when the read failed. */
async function readHousesByWorkspace(db: SupabaseClient, accountUserId: string): Promise<Map<string, string[]> | null> {
  const res = await db.from("manager_property_records").select("id, workspace_id").eq("manager_user_id", accountUserId);
  if (res.error) return null;
  const out = new Map<string, string[]>();
  for (const row of (res.data ?? []) as { id: unknown; workspace_id: unknown }[]) {
    const workspaceId = String(row.workspace_id ?? "").trim();
    if (!workspaceId) continue;
    out.set(workspaceId, [...(out.get(workspaceId) ?? []), String(row.id)]);
  }
  return out;
}

async function loadAccount(db: SupabaseClient, accountUserId: string): Promise<ServiceResult<{ account: { id: string; name: string; email: string } }>> {
  if (!UUID.test(accountUserId)) return fail(400, "Choose an account.");
  const res = await db.from("profiles").select("id, full_name, email").eq("id", accountUserId).maybeSingle();
  if (res.error) return fail(503, "Could not read the account. Please retry.");
  if (!res.data) return fail(404, "Account not found.");
  const p = res.data as { id: string; full_name: string | null; email: string | null };
  return { ok: true, account: { id: p.id, name: p.full_name?.trim() || p.email?.trim() || "", email: p.email?.trim() || "" } };
}

/** The sheet's list: the account's workspaces that are not yet PropLane-managed, with their house counts. */
export async function listAccountWorkspacesForManaging(
  db: SupabaseClient,
  operatorUserId: string,
  accountUserId: unknown,
): Promise<ServiceResult<{ account: { id: string; name: string; email: string }; workspaces: ManagedAccountWorkspace[]; managedCount: number }>> {
  if (!(await userHoldsAdminRole(db, operatorUserId))) return fail(403, "Only a PropLane admin can manage an account's homes.");
  const loaded = await loadAccount(db, typeof accountUserId === "string" ? accountUserId.trim() : "");
  if (!loaded.ok) return loaded;
  const serviceOwner = await resolveServiceOwner(db);
  if (!serviceOwner.ok) return fail(serviceOwner.reason === "not_configured" ? 409 : 503, serviceOwner.reason === "not_configured" ? SERVICE_NOT_CONFIGURED : "Could not reach the service settings. Please retry.");
  if (loaded.account.id === serviceOwner.ownerUserId) return fail(409, "PropLane already owns these workspaces.");
  const [owned, houses] = await Promise.all([readOwnedWorkspaces(db, loaded.account.id), readHousesByWorkspace(db, loaded.account.id)]);
  if (!owned || !houses) return fail(503, "Could not load the account's workspaces. Please retry.");
  return {
    ok: true,
    account: loaded.account,
    managedCount: owned.filter((w) => w.isService).length,
    workspaces: owned
      .filter((w) => !w.isService)
      .map((w) => ({ id: w.id, name: w.name, city: w.city, houseCount: (houses.get(w.id) ?? []).length, isDefault: w.isDefault })),
  };
}

export type ManageByProplaneInput = {
  accountUserId: unknown;
  mode: unknown;
  workspaceIds: unknown;
  /** Combine only: the workspace that stays and receives the others' houses. */
  targetId?: unknown;
  city: unknown;
  /** One workspace only: the name it carries once managed. */
  label?: unknown;
  /** Percent PropLane keeps; absent leaves the automatic default. */
  feePercent?: unknown;
};

export type ManageByProplaneResult = {
  attached: string[];
  moved: { from: string; to: string; houseIds: string[] }[];
  archived: string[];
  /** Emptied workspaces left listed: the owner's default workspace is where a house with no workspace lands. */
  kept: string[];
  /** Fee changes that did not apply (the workspace is attached either way). */
  feeErrors: string[];
};

async function markAudits(
  db: SupabaseClient,
  operatorUserId: string,
  audits: { key: string; ownerId: string }[],
  result: Record<string, unknown>,
): Promise<void> {
  for (const audit of audits) {
    try {
      await updateAuditResult({ db, landlordId: audit.ownerId, userId: operatorUserId }, audit.key, result);
    } catch (error) {
      console.error("[managed-by-proplane] audit result was not updated", error instanceof Error ? error.name : "unknown");
    }
  }
}

export async function manageAccountByProplane(
  db: SupabaseClient,
  operatorUserId: string,
  input: ManageByProplaneInput,
): Promise<ServiceResult<ManageByProplaneResult>> {
  if (!(await userHoldsAdminRole(db, operatorUserId))) return fail(403, "Only a PropLane admin can manage an account's homes.");
  const mode = input.mode === "combine" ? "combine" : input.mode === "pick" ? "pick" : null;
  if (!mode) return fail(400, "Choose workspaces or combine them into one.");
  const requested = Array.isArray(input.workspaceIds) ? input.workspaceIds.map((id) => (typeof id === "string" ? id.trim() : "")) : [];
  if (requested.length === 0 || requested.length > 25 || requested.some((id) => !UUID.test(id))) return fail(400, "Choose at least one workspace.");
  const ids = [...new Set(requested.map((id) => id.toLowerCase()))];
  const city = cleanServiceCity(input.city);
  if (city === undefined) return fail(400, "Use a city of up to 80 characters.");
  const label = cleanOwnerOfRecord(input.label);
  if (label === undefined) return fail(400, "Use a label of up to 80 characters.");
  let feePercent: number | null = null;
  if (input.feePercent !== undefined && input.feePercent !== null && input.feePercent !== "") {
    if (ownerShareBpsForFeePercent(input.feePercent) === null) return fail(400, MANAGEMENT_FEE_RANGE_MESSAGE);
    feePercent = Number(input.feePercent);
  }
  let targetId = "";
  if (mode === "combine") {
    targetId = typeof input.targetId === "string" ? input.targetId.trim().toLowerCase() : "";
    if (ids.length < 2) return fail(400, "Combine needs at least two workspaces.");
    if (!ids.includes(targetId)) return fail(400, "Choose which of the workspaces stays.");
  }

  const loaded = await loadAccount(db, typeof input.accountUserId === "string" ? input.accountUserId.trim() : "");
  if (!loaded.ok) return loaded;
  const accountId = loaded.account.id;
  const serviceOwner = await resolveServiceOwner(db);
  if (!serviceOwner.ok) return fail(serviceOwner.reason === "not_configured" ? 409 : 503, serviceOwner.reason === "not_configured" ? SERVICE_NOT_CONFIGURED : "Could not reach the service settings. Please retry.");
  if (accountId === serviceOwner.ownerUserId) return fail(409, "PropLane already owns these workspaces.");

  // Everything below is re-derived from the database: the ids in the body only NAME rows, and each must be one of this
  // account's own active, unmanaged workspaces. A failed read refuses the whole request before anything is written.
  const [owned, houses] = await Promise.all([readOwnedWorkspaces(db, accountId), readHousesByWorkspace(db, accountId)]);
  if (!owned || !houses) return fail(503, "Could not read the account's workspaces. Nothing was changed.");
  const ownedById = new Map(owned.map((w) => [w.id.toLowerCase(), w]));
  for (const id of ids) {
    const workspace = ownedById.get(id);
    if (!workspace) return fail(404, "One of those workspaces is not on this account.");
    if (workspace.isService) return fail(409, `${workspace.name} is already managed by PropLane.`);
  }
  const resolve = (id: string) => ownedById.get(id)!;
  const result: ManageByProplaneResult = { attached: [], moved: [], archived: [], kept: [], feeErrors: [] };

  const attachOne = async (workspaceId: string): Promise<ServiceFailure | null> => {
    const attached = await attachWorkspaceToService(db, operatorUserId, {
      workspaceId: resolve(workspaceId).id,
      city,
      label: ids.length === 1 ? label : null,
      reason: MANAGED_BY_PROPLANE_REASON,
    });
    if (!attached.ok) return attached;
    result.attached.push(attached.id);
    if (feePercent !== null) {
      const fee = await setServiceWorkspaceFee(db, operatorUserId, { id: attached.id, percent: feePercent });
      if (!fee.ok) result.feeErrors.push(`${resolve(workspaceId).name}: ${fee.error}`);
    }
    return null;
  };

  if (mode === "pick") {
    for (const id of ids) {
      const failed = await attachOne(id);
      if (failed) {
        const done = result.attached.length;
        return fail(failed.status, done > 0 ? `${failed.error} ${done} of ${ids.length} workspaces were attached before it stopped.` : failed.error);
      }
    }
    return { ok: true, ...result };
  }

  // Combine. Sources are every chosen workspace but the target; their houses are read now and moved by id.
  const sources = ids.filter((id) => id !== targetId);
  const plan = sources.map((from) => ({ from: resolve(from).id, houseIds: [...(houses.get(resolve(from).id) ?? [])].sort() }));
  const audits: { key: string; ownerId: string }[] = [];
  for (const step of plan) {
    const key = `${ADMIN_SERVICE_COMBINE_MOVE_AUDIT_ACTION}:${step.from}:${randomUUID()}`;
    const audit = await writeAuditLog(
      { db, landlordId: accountId, userId: operatorUserId },
      {
        action: ADMIN_SERVICE_COMBINE_MOVE_AUDIT_ACTION,
        toolName: ADMIN_SERVICE_COMBINE_MOVE_AUDIT_ACTION,
        inputSummary: { fromWorkspaceId: step.from, toWorkspaceId: resolve(targetId).id, ownerUserId: accountId, houseCount: step.houseIds.length, houseIds: step.houseIds },
        resultSummary: { applied: false },
        dedupeKey: key,
      },
    );
    if (!audit.recorded) {
      await markAudits(db, operatorUserId, audits, { applied: false, error: "not_started" });
      return fail(503, "Could not record the audit entry, so nothing was changed. Please retry.");
    }
    audits.push({ key, ownerId: accountId });
  }

  // The move runs BEFORE the attach, and the RPC does not care whether the target is managed yet. The other order
  // leaves a refused move unretryable: the attached target drops out of the sheet (`listAccountWorkspacesForManaging`
  // lists only unmanaged workspaces) and the pre-flight above refuses it by name, with the sources still loose.
  const combined = await db.rpc("combine_portal_workspaces", { p_owner: accountId, p_target: resolve(targetId).id, p_sources: plan.map((s) => s.from) });
  if (combined.error || !combined.data || typeof combined.data !== "object") {
    await markAudits(db, operatorUserId, audits, { applied: false, error: "move_refused" });
    const stale = combined.error?.code === "23514";
    return fail(
      stale ? 409 : 503,
      `The workspaces were not combined, nothing was moved and none of them is managed by PropLane${stale ? ": they changed while you were working. Reload and try again." : ". Please retry."}`,
    );
  }
  const answer = combined.data as { moved?: unknown; archived?: unknown; kept?: unknown };
  const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  const movedIds = new Set(strings(answer.moved));
  result.archived = strings(answer.archived);
  result.kept = strings(answer.kept);
  result.moved = plan.map((step) => ({ from: step.from, to: resolve(targetId).id, houseIds: step.houseIds.filter((id) => movedIds.has(id)) }));
  await markAudits(db, operatorUserId, audits, { applied: true, moved: movedIds.size, archived: result.archived.length });

  const attachFailed = await attachOne(targetId);
  if (attachFailed) {
    return fail(
      attachFailed.status,
      `${attachFailed.error} The homes are all in ${resolve(targetId).name} now, which is not managed by PropLane yet - choose just that workspace to finish.`,
    );
  }
  return { ok: true, ...result };
}
