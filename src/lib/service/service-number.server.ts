import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import { isProvisioningEnabled, normalizeSmsRuntimeMode } from "@/lib/sms/number-registration-policy";
import { getWorkspaceNumberRecord } from "@/lib/sms/manager-number-provisioning.server";
import { provisionNumberForWorkspace } from "@/lib/sms/work-numbers.server";
import { actorWorkspaceStanding } from "@/lib/workspaces/membership.server";
import { loadServiceWorkspace } from "@/lib/service/service-owner.server";
import type { ServiceResult } from "@/lib/service/service-workspaces.server";

/**
 * A service workspace's OWN work number, separate from the shared PropLane line.
 *
 * It runs the same per-workspace provisioning as a manager's (`provisionNumberForWorkspace`
 * and the same runtime kill switches), with two deliberate differences:
 *   * the owner is the service owner, whose entitlement is granted regardless of plan
 *     (`reconcileManagerSmsEntitlement` -> `isPlatformServiceOwner`), and it is exempt from
 *     the per-plan number budget; the one-number-per-workspace cap still applies;
 *   * the buyer is an admin operator acting on the OWNER's behalf, so the manager route's
 *     "only the owner buys" refusal does not apply - the operator must run this workspace
 *     (owner or Admin) instead, re-derived here.
 */
export async function requestServiceWorkspaceNumber(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; areaCode?: unknown },
): Promise<ServiceResult<{ workNumber: string | null; state: string }>> {
  const areaCode = typeof input.areaCode === "string" ? input.areaCode.trim() : "";
  if (areaCode && !/^\d{3}$/.test(areaCode)) return { ok: false, status: 400, error: "Area code must be 3 digits." };

  const workspace = await loadServiceWorkspace(db, input.id);
  if (!workspace) return { ok: false, status: 404, error: "Service workspace not found." };
  const standing = await actorWorkspaceStanding(db, operatorUserId, workspace.id);
  if (!standing || !standing.rights.members) {
    return { ok: false, status: 403, error: "Only the owner or an admin of this workspace can set up its number." };
  }

  const entitlement = await reconcileManagerSmsEntitlement(db, workspace.ownerUserId);
  if (!entitlement.eligible) {
    return { ok: false, status: 503, error: "We could not verify the service number plan. Try again." };
  }

  const { data: runtime, error: runtimeError } = await db
    .from("sms_runtime_config")
    .select("mode, pilot_manager_user_ids")
    .eq("singleton", true)
    .maybeSingle();
  const mode = runtimeError ? "paused" : normalizeSmsRuntimeMode(runtime?.mode);
  if (!isProvisioningEnabled() || mode === "paused") {
    return { ok: false, status: 503, error: "Number requests are paused right now." };
  }
  const allowlist = Array.isArray(runtime?.pilot_manager_user_ids) ? runtime.pilot_manager_user_ids.map(String) : [];
  if (mode === "allowlisted_self_service" && !allowlist.includes(workspace.ownerUserId)) {
    return { ok: false, status: 403, error: "Number setup is not available for the service account yet." };
  }

  const result = await provisionNumberForWorkspace(db, workspace.ownerUserId, {
    workspaceId: workspace.id,
    ...(areaCode ? { areaCode } : {}),
  });
  if (!result.ok) {
    return { ok: false, status: result.state === "pending_registration" ? 503 : 502, error: "We could not set up this number. Try again later." };
  }
  const record = await getWorkspaceNumberRecord(db, workspace.id);
  return { ok: true, workNumber: record?.phoneNumber ?? null, state: record?.provisionState ?? result.state };
}
