import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCommunicationGrant, grantCoversHouse } from "@/lib/one-number/communication-grant.server";
import { propertyInWorkspace } from "@/lib/listing-channels/route-context.server";
import { resolveSharedLineHumanSend } from "@/lib/one-number/shared-line-number.server";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { WORKSPACE_NO_WORK_NUMBER_CODE } from "@/lib/sms/workspace-no-work-number";
import { ManagedReadOnlyError, resolveWorkspaceFromSettingsRequest } from "@/lib/workspaces/active.server";

/**
 * "Message a whole house", the send-side authority. A house text is ABOUT one workspace: it leaves from that
 * workspace's work number and its OWNER's wallet pays, whoever is signed in (the owner with two workspaces, a
 * teammate, a PropLane staff seat). The body's `houseSendPropertyId` is only a name: the workspace and the owner
 * are re-derived here from the signed-in actor's access to that house, exactly as `GET /api/portal/house-recipients`
 * proves it, and nothing is taken from the request.
 */
export type HouseSendTarget = {
  propertyId: string;
  workspaceId: string;
  /** The workspace OWNER: whose line, wallet and plan the text is about. Never the signed-in actor. */
  ownerUserId: string;
};

export type HouseSendTargetResult =
  | { ok: true; target: HouseSendTarget }
  | { ok: false; status: 403 | 404 | 503; error: string };

export async function resolveHouseSendTarget(
  db: SupabaseClient,
  input: { request: Request; userId: string; propertyId: string },
): Promise<HouseSendTargetResult> {
  const propertyId = input.propertyId.trim();
  if (!propertyId) return { ok: false, status: 404, error: "Property not found." };
  let workspace: Awaited<ReturnType<typeof resolveWorkspaceFromSettingsRequest>>;
  try {
    workspace = await resolveWorkspaceFromSettingsRequest(db, input.userId, input.request, null);
  } catch (error) {
    // A PropLane-managed workspace is view-only for its own client; a failed read refuses rather than guesses.
    if (error instanceof ManagedReadOnlyError) return { ok: false, status: 403, error: error.message };
    return { ok: false, status: 503, error: "Could not verify your access. Try again." };
  }
  const access = await resolveCommunicationGrant(db, input.userId, workspace, "edit");
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  if (!grantCoversHouse(access.grant, propertyId) || !(await propertyInWorkspace(db, workspace, propertyId))) {
    return { ok: false, status: 404, error: "Property not found." };
  }
  return { ok: true, target: { propertyId, workspaceId: workspace.id, ownerUserId: workspace.ownerUserId } };
}

export type HouseSmsLine =
  | {
      ok: true;
      /** The number the text leaves from, when it is a row of its own (null on the shared PropLane line). */
      fromNumber: string | null;
      /** `manager_sms_numbers.id` the outbox pins, re-checked by the dispatcher at the provider boundary. */
      selectedWorkLineId: string | null;
      /** "<house> team" on the shared line; null otherwise. */
      signOff: string | null;
    }
  | { ok: false; error: string };

/**
 * The line a text about this house leaves on. Reuses the resolvers every other workspace send uses:
 *   - shared PropLane line (`resolveSharedLineHumanSend`): the one shared number, signed "<house> team";
 *   - otherwise `resolveWorkspaceSendLine`, which answers PropLane-MANAGED (`is_service`) workspaces with the PropLane
 *     line (`resolveServiceLine`) and every other workspace with ITS OWN registered number.
 * A workspace with no sendable line, or one that cannot be read, is a REFUSAL: the text is never sent from another
 * workspace's number (the owner's default included).
 */
export async function resolveHouseSmsLine(db: SupabaseClient, target: HouseSendTarget): Promise<HouseSmsLine> {
  const shared = await resolveSharedLineHumanSend(db, { ownerUserId: target.ownerUserId, propertyId: target.propertyId });
  if (shared && shared.workspaceId === target.workspaceId) {
    return { ok: true, fromNumber: null, selectedWorkLineId: null, signOff: shared.signOff };
  }
  let line: Awaited<ReturnType<typeof resolveWorkspaceSendLine>>;
  try {
    line = await resolveWorkspaceSendLine(db, target.ownerUserId, target.workspaceId, { failClosed: true });
  } catch {
    return { ok: false, error: "control_plane_unreadable" };
  }
  if (!line) return { ok: false, error: WORKSPACE_NO_WORK_NUMBER_CODE };
  return { ok: true, fromNumber: line.phoneNumber, selectedWorkLineId: line.numberId, signOff: null };
}
