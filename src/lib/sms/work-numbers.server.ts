import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaceById } from "@/lib/workspaces/active.server";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { loadManagerPlanAddonQuantities } from "@/lib/plan-addons.server";
import {
  provisionManagerNumber,
  type ProvisionResult,
} from "@/lib/sms/manager-number-provisioning.server";

/**
 * Work numbers per workspace (part 3, Sep 2026): a workspace may hold up to
 * TWO work numbers, and one physical number may serve two workspaces (its
 * thread shows in every holding workspace, either can send from it). The
 * many-to-many `workspace_work_numbers` join table
 * (`20260920214000_work_numbers_per_workspace.sql`) is the only truth for
 * "which numbers does this workspace hold" — never `manager_sms_numbers`'s
 * own `workspace_id` column alone, which stays the number's fixed HOME
 * placement (one row per home workspace; that shape is untouched, see the
 * migration header). RLS on the join table is SELECT-only for authenticated
 * clients scoped to a workspace they own; every write here uses the
 * service-role client the caller already holds (`requireManagerRouteUser`).
 */

/** Hard ceiling, mirrored by the database trigger. */
export const WORKSPACE_WORK_NUMBER_LIMIT = 1;

export type WorkspaceNumberEntry = {
  numberId: string;
  phoneNumber: string | null;
  isPrimary: boolean;
  provisionState: string | null;
  /** Other workspaces (owned by the same account) that also hold this number. */
  sharedWithWorkspaceIds: string[];
  sharedWithWorkspaceNames: string[];
};

const NUMBER_COLUMNS = "id, phone_number, provision_state";

function cleanId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Every number a workspace holds via the join table, primary first. A number
 * shared in from a sibling workspace is listed the same as the workspace's
 * own home number — the join table does not distinguish "home" from
 * "shared", only `manager_sms_numbers.workspace_id` (elsewhere) does.
 */
export async function listWorkspaceNumbers(
  db: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceNumberEntry[]> {
  const id = cleanId(workspaceId);
  if (!id) return [];
  const { data: holds, error } = await db
    .from("workspace_work_numbers")
    .select("number_id, is_primary")
    .eq("workspace_id", id)
    .order("is_primary", { ascending: false });
  if (error || !holds || holds.length === 0) return [];

  const numberIds = [...new Set(holds.map((h) => cleanId(h.number_id)).filter(Boolean))];
  if (numberIds.length === 0) return [];

  const [{ data: numberRows }, { data: allHolders }] = await Promise.all([
    db.from("manager_sms_numbers").select(NUMBER_COLUMNS).in("id", numberIds),
    db.from("workspace_work_numbers").select("workspace_id, number_id").in("number_id", numberIds),
  ]);

  const numberById = new Map((numberRows ?? []).map((r) => [cleanId(r.id), r]));
  const holdersByNumber = new Map<string, string[]>();
  for (const row of allHolders ?? []) {
    const numberId = cleanId(row.number_id);
    const ws = cleanId(row.workspace_id);
    if (!numberId || !ws || ws === id) continue;
    const list = holdersByNumber.get(numberId) ?? [];
    list.push(ws);
    holdersByNumber.set(numberId, list);
  }
  const otherWorkspaceIds = [...new Set([...holdersByNumber.values()].flat())];
  const nameById = new Map<string, string>();
  if (otherWorkspaceIds.length > 0) {
    const { data: wsRows } = await db.from("portal_workspaces").select("id, name").in("id", otherWorkspaceIds);
    for (const w of wsRows ?? []) nameById.set(cleanId(w.id), String(w.name ?? "").trim());
  }

  return holds
    .map((hold) => {
      const numberId = cleanId(hold.number_id);
      const row = numberById.get(numberId) as { id?: unknown; phone_number?: unknown; provision_state?: unknown } | undefined;
      const others = holdersByNumber.get(numberId) ?? [];
      return {
        numberId,
        phoneNumber: row && typeof row.phone_number === "string" ? row.phone_number : null,
        isPrimary: Boolean(hold.is_primary),
        provisionState: row && typeof row.provision_state === "string" ? row.provision_state : null,
        sharedWithWorkspaceIds: others,
        sharedWithWorkspaceNames: others.map((o) => nameById.get(o) || "another workspace"),
      };
    })
    .filter((entry) => entry.numberId);
}

export type WorkNumberMutationResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      code: "not_authorized" | "cap_exceeded" | "already_assigned" | "not_found" | "setup_locked";
    };

/**
 * Assign an existing number to a SECOND workspace. Both workspaces, and the
 * number's current holder, are re-derived from the database — a body id is
 * never authorization on its own. The actor must own the destination
 * workspace AND already own a workspace that holds the number (sharing OUT
 * your own line, never someone else's).
 */
/**
 * Cross-workspace sharing is retired: each workspace owns at most one work
 * number, provisioned for that workspace. Legacy `workspace_work_numbers`
 * share rows can still be cleared with `unassignNumber`.
 */
export async function assignNumberToWorkspace(
  _db: SupabaseClient,
  _actorUserId: string,
  _opts: { numberId: string; workspaceId: string },
): Promise<WorkNumberMutationResult> {
  return {
    ok: false,
    error: "A work number belongs to one workspace. Request a number for that workspace instead of sharing one.",
    code: "not_authorized",
  };
}

/**
 * Remove a number from a workspace. Only the workspace's own owner may change
 * its numbers. A workspace's own set-up number (primary / home) can never be
 * removed — Setup is permanent for that workspace. Legacy shared-in holds
 * (`is_primary` false) may still be cleared so the list can shed retired
 * cross-workspace shares.
 */
export async function unassignNumber(
  db: SupabaseClient,
  actorUserId: string,
  opts: { numberId: string; workspaceId: string },
): Promise<WorkNumberMutationResult> {
  const numberId = cleanId(opts.numberId);
  const workspaceId = cleanId(opts.workspaceId);
  const actor = cleanId(actorUserId);
  if (!numberId || !workspaceId || !actor) {
    return { ok: false, error: "Number and workspace are required.", code: "not_found" };
  }
  const workspace = await loadWorkspaceById(db, workspaceId);
  if (!workspace || workspace.ownerUserId !== actor) {
    return { ok: false, error: "You cannot change numbers on that workspace.", code: "not_authorized" };
  }
  const { data: existing } = await db
    .from("workspace_work_numbers")
    .select("number_id, is_primary")
    .eq("workspace_id", workspaceId)
    .eq("number_id", numberId)
    .maybeSingle();
  if (!existing) {
    return { ok: false, error: "This workspace does not hold that number.", code: "not_found" };
  }

  const wasPrimary = Boolean(existing.is_primary);
  const { data: homeRow } = await db
    .from("manager_sms_numbers")
    .select("id, workspace_id")
    .eq("id", numberId)
    .maybeSingle();
  const isHomeForWorkspace = cleanId(homeRow?.workspace_id) === workspaceId;
  if (wasPrimary || isHomeForWorkspace) {
    return {
      ok: false,
      error: "A work number cannot be removed once this workspace has set it up.",
      code: "setup_locked",
    };
  }

  const { error } = await db
    .from("workspace_work_numbers")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("number_id", numberId);
  if (error) return { ok: false, error: "Could not remove this number.", code: "not_found" };

  return { ok: true };
}

/**
 * Included work numbers per workspace, before any `extra_work_number`
 * add-on. Round 3 plan model (docs/agents/comms-billing.md): Pro includes one
 * number for its one workspace; Business includes one per workspace — so
 * every workspace a paid account owns includes exactly one. `workspaces/types.ts`
 * has no `includedWorkNumbers` export to reuse (checked at merge time); this
 * is the local stand-in noted in the build contract.
 */
function includedNumbersPerOwnedWorkspace(tier: "free" | "pro" | "business" | null): number {
  return tier === "pro" || tier === "business" ? 1 : 0;
}

export type ProvisionForWorkspaceResult =
  | ProvisionResult
  | {
      ok: false;
      error: string;
      state: "failed";
      code: "not_authorized" | "cap_exceeded" | "budget_exceeded";
    };

/**
 * Provision a work number for a workspace, gated by the account-wide
 * included + `extra_work_number` add-on budget and by this workspace's own
 * 1-number cap.
 *
 * `manager_sms_numbers` keeps ONE row per home workspace (unique index). A
 * workspace that already has its home number cannot buy another through this
 * path — each workspace gets exactly one work number.
 */
export async function provisionNumberForWorkspace(
  db: SupabaseClient,
  actorUserId: string,
  opts: { workspaceId: string; areaCode?: string },
): Promise<ProvisionForWorkspaceResult> {
  const actor = cleanId(actorUserId);
  const workspaceId = cleanId(opts.workspaceId);
  if (!actor || !workspaceId) {
    return { ok: false, error: "Workspace is required.", state: "failed", code: "not_authorized" };
  }
  const workspace = await loadWorkspaceById(db, workspaceId);
  if (!workspace || workspace.ownerUserId !== actor) {
    return { ok: false, error: "You cannot request a number for that workspace.", state: "failed", code: "not_authorized" };
  }

  const { data: heldNow } = await db.from("workspace_work_numbers").select("number_id").eq("workspace_id", workspaceId);
  if ((heldNow?.length ?? 0) >= WORKSPACE_WORK_NUMBER_LIMIT) {
    return { ok: false, error: "A workspace can hold at most 1 work number.", state: "failed", code: "cap_exceeded" };
  }

  const { data: existingHome } = await db
    .from("manager_sms_numbers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (existingHome?.id) {
    return {
      ok: false,
      error: "This workspace already has its work number.",
      state: "failed",
      code: "cap_exceeded",
    };
  }

  // Account-wide budget: included (one per owned workspace on a paid plan)
  // plus the extra_work_number add-on quantity, compared against every home
  // number the account already holds across all of its own workspaces.
  const [tierResult, addons, { data: ownedWorkspaces }, { data: homeNumbers }] = await Promise.all([
    getEffectiveManagerSkuTier(actor),
    loadManagerPlanAddonQuantities(db, actor),
    db.from("portal_workspaces").select("id").eq("owner_user_id", actor),
    db.from("manager_sms_numbers").select("id").eq("manager_user_id", actor),
  ]);
  if (!tierResult.ok) {
    return { ok: false, error: "Could not verify your plan.", state: "failed", code: "budget_exceeded" };
  }
  if (!addons.ok) {
    return { ok: false, error: "Could not verify your add-ons.", state: "failed", code: "budget_exceeded" };
  }
  const ownedCount = (ownedWorkspaces ?? []).length;
  const included = includedNumbersPerOwnedWorkspace(tierResult.tier) * ownedCount;
  const extra = Math.max(0, addons.quantities.extra_work_number ?? 0);
  const budget = included + extra;
  const held = (homeNumbers ?? []).length;
  if (held >= budget) {
    return {
      ok: false,
      error: "You're at your included work numbers. Add an extra work number in Billing & plan to buy another.",
      state: "failed",
      code: "budget_exceeded",
    };
  }

  const result = await provisionManagerNumber(db, actor, {
    workspaceId,
    ...(opts.areaCode ? { areaCode: opts.areaCode } : {}),
  });
  if (result.ok) {
    // Keep the join table in sync with the newly-homed number. Idempotent:
    // a retry or an already-provisioned response never duplicates the row.
    const { data: homeRow } = await db
      .from("manager_sms_numbers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (homeRow?.id) {
      await db
        .from("workspace_work_numbers")
        .upsert(
          { workspace_id: workspaceId, number_id: homeRow.id, is_primary: true },
          { onConflict: "workspace_id,number_id", ignoreDuplicates: true },
        );
    }
  }
  return result;
}
