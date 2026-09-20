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
 * (`20260920210000_work_numbers_per_workspace.sql`) is the only truth for
 * "which numbers does this workspace hold" — never `manager_sms_numbers`'s
 * own `workspace_id` column alone, which stays the number's fixed HOME
 * placement (one row per home workspace; that shape is untouched, see the
 * migration header). RLS on the join table is SELECT-only for authenticated
 * clients scoped to a workspace they own; every write here uses the
 * service-role client the caller already holds (`requireManagerRouteUser`).
 */

/** Hard ceiling, mirrored by the database trigger. */
export const WORKSPACE_WORK_NUMBER_LIMIT = 2;

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
      code: "not_authorized" | "cap_exceeded" | "already_assigned" | "not_found";
    };

/**
 * Assign an existing number to a SECOND workspace. Both workspaces, and the
 * number's current holder, are re-derived from the database — a body id is
 * never authorization on its own. The actor must own the destination
 * workspace AND already own a workspace that holds the number (sharing OUT
 * your own line, never someone else's).
 */
export async function assignNumberToWorkspace(
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

  const destination = await loadWorkspaceById(db, workspaceId);
  if (!destination || destination.ownerUserId !== actor) {
    return { ok: false, error: "You cannot assign a number to that workspace.", code: "not_authorized" };
  }

  const { data: holderRows, error: holderError } = await db
    .from("workspace_work_numbers")
    .select("workspace_id")
    .eq("number_id", numberId);
  if (holderError) return { ok: false, error: "Could not verify this number.", code: "not_found" };
  const holderWorkspaceIds = [...new Set((holderRows ?? []).map((r) => cleanId(r.workspace_id)).filter(Boolean))];
  if (holderWorkspaceIds.length === 0) {
    return { ok: false, error: "That number does not exist.", code: "not_found" };
  }
  if (holderWorkspaceIds.includes(workspaceId)) {
    return { ok: false, error: "This workspace already has that number.", code: "already_assigned" };
  }

  // Re-derive authorization from the join table, not the caller's say-so: the
  // actor must already OWN one of the workspaces currently holding this
  // number, otherwise they are sharing a line that is not theirs.
  const { data: ownedHolders } = await db
    .from("portal_workspaces")
    .select("id")
    .in("id", holderWorkspaceIds)
    .eq("owner_user_id", actor);
  if (!ownedHolders || ownedHolders.length === 0) {
    return { ok: false, error: "You cannot share a number you do not hold.", code: "not_authorized" };
  }

  const { data: existingHolds } = await db.from("workspace_work_numbers").select("number_id").eq("workspace_id", workspaceId);
  if ((existingHolds?.length ?? 0) >= WORKSPACE_WORK_NUMBER_LIMIT) {
    return { ok: false, error: "A workspace can hold at most 2 work numbers.", code: "cap_exceeded" };
  }

  const { error: insertError } = await db
    .from("workspace_work_numbers")
    .insert({ workspace_id: workspaceId, number_id: numberId, is_primary: false });
  if (insertError) {
    const message = String(insertError.message ?? "");
    if (message.includes("at most 2")) {
      return { ok: false, error: "A workspace can hold at most 2 work numbers.", code: "cap_exceeded" };
    }
    if ((insertError as { code?: string }).code === "23505") {
      return { ok: false, error: "This workspace already has that number.", code: "already_assigned" };
    }
    return { ok: false, error: "Could not assign this number.", code: "not_found" };
  }
  return { ok: true };
}

/**
 * Remove a number from a workspace. Only the workspace's own owner may change
 * its numbers. Unassigning the last number a workspace holds is allowed — the
 * workspace simply has none, same as before any number was set up. The
 * number itself is never deleted; it may still be held by another workspace.
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
  const { error } = await db
    .from("workspace_work_numbers")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("number_id", numberId);
  if (error) return { ok: false, error: "Could not remove this number.", code: "not_found" };

  // Removing the HOME copy of a number that another workspace still shares in
  // leaves that number with no primary holder. Promote the earliest remaining
  // holder so outbound resolution keeps a deterministic primary.
  if (wasPrimary) {
    const { data: remaining } = await db
      .from("workspace_work_numbers")
      .select("workspace_id, created_at")
      .eq("number_id", numberId)
      .order("created_at", { ascending: true })
      .limit(1);
    const next = remaining?.[0];
    if (next) {
      await db
        .from("workspace_work_numbers")
        .update({ is_primary: true })
        .eq("workspace_id", next.workspace_id)
        .eq("number_id", numberId);
    }
  }
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
      code: "not_authorized" | "cap_exceeded" | "budget_exceeded" | "second_number_via_share_only";
    };

/**
 * Provision a work number for a workspace, gated by the account-wide
 * included + `extra_work_number` add-on budget and by this workspace's own
 * 2-number cap.
 *
 * `manager_sms_numbers` keeps ONE row per home workspace (unique index,
 * untouched by the join-table migration — the money-guarded Twilio purchase
 * state machine in manager-number-provisioning.server.ts is keyed on it and is
 * out of scope for this change). So a workspace that already has its own home
 * number cannot buy a second one through this path: a genuine second number
 * for that workspace must be SHARED IN from a sibling workspace via
 * `assignNumberToWorkspace`, not purchased twice into the same home slot.
 * Documented departure — the plan's "Add number · $5/mo" row shown on a
 * workspace that already has one is intentionally refused here rather than
 * silently faking a second purchase or altering the money-guarded state
 * machine; see the build report for the recommended follow-up.
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
    return { ok: false, error: "A workspace can hold at most 2 work numbers.", state: "failed", code: "cap_exceeded" };
  }

  const { data: existingHome } = await db
    .from("manager_sms_numbers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (existingHome?.id) {
    return {
      ok: false,
      error: "This workspace already has its own number. Share a number in from another workspace instead of buying a second one.",
      state: "failed",
      code: "second_number_via_share_only",
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
