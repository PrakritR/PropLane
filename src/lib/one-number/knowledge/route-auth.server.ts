import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertManagerCommunicationAllowedForWorkspace } from "@/lib/manager-communication-access.server";
import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { resolveCommunicationGrant } from "@/lib/one-number/communication-grant.server";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveActiveWorkspaceFromRequest } from "@/lib/workspaces/active.server";
import { loadOwnedProperty } from "./scope.server";

export type KnowledgeActor = {
  userId: string;
  db: SupabaseClient;
  workspaceId: string;
  ownerUserId: string;
  /** The workspace owner may manage team-wide answers and every house. */
  isOwner: boolean;
  /** Houses a non-owner may write for; null for the owner. */
  allowedPropertyIds: readonly string[] | null;
};

export type KnowledgeActorResult = { ok: true; actor: KnowledgeActor } | { ok: false; response: NextResponse };

function fail(status: number, error: string): KnowledgeActorResult {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/**
 * Re-derive everything from the signed-in manager: their role (`profile_roles`, so a resident or vendor
 * login never provisions a workspace here), the ACTIVE workspace (never an id in the request), then
 * Communication access in it. The owner keeps every house; a teammate needs the Communication (inbox)
 * module granted on the house, `read` for a read and `edit` for anything that changes state, and sees
 * only those houses. House membership alone is not a grant. A workspace or entry id in a body is not
 * authorization.
 */
export async function requireKnowledgeActor(level: "read" | "edit" = "edit"): Promise<KnowledgeActorResult> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return fail(401, "Unauthorized.");
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return fail(403, "Communication is not available.");
  // Role first: resolving the workspace below provisions one for an account that has none.
  let manager = false;
  try {
    manager = await userHoldsManagerRole(db, user.id);
  } catch {
    return fail(503, "Could not verify your account. Try again.");
  }
  if (!manager) return fail(403, "Forbidden.");
  const ownerRefusal = await refuseOwnerOnly(db, user.id);
  if (ownerRefusal) return { ok: false, response: ownerRefusal };
  let workspace;
  try {
    workspace = await resolveActiveWorkspaceFromRequest(db, user.id);
  } catch {
    return fail(503, "Workspace unavailable.");
  }
  const granted = await resolveCommunicationGrant(db, user.id, workspace, level);
  if (!granted.ok) return fail(granted.status, granted.error);
  const access = await assertManagerCommunicationAllowedForWorkspace(db, user.id, workspace.id).catch(() => null);
  if (!access?.allowed) return fail(403, "Communication is not available.");
  const isOwner = granted.grant.isOwner;
  return {
    ok: true,
    actor: {
      userId: user.id,
      db,
      workspaceId: workspace.id,
      ownerUserId: workspace.ownerUserId,
      isOwner,
      allowedPropertyIds: isOwner ? null : [...(granted.grant.grantedPropertyIds ?? [])],
    },
  };
}

/** A house id from a request is usable only when it is in THIS workspace and the actor may write to it. */
export async function houseUsableByActor(actor: KnowledgeActor, propertyId: string): Promise<boolean> {
  const id = propertyId.trim();
  if (!id) return false;
  if (actor.allowedPropertyIds && !actor.allowedPropertyIds.includes(id)) return false;
  const owned = await loadOwnedProperty(actor.db, actor.ownerUserId, id);
  return Boolean(owned && owned.workspaceId === actor.workspaceId);
}
