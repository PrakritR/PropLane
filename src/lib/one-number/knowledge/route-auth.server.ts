import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertManagerCommunicationAllowedForWorkspace } from "@/lib/manager-communication-access.server";
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
 * Re-derive everything from the signed-in manager: the ACTIVE workspace (never an id in the
 * request), then Communication access in it. A workspace or entry id in a body is not authorization.
 */
export async function requireKnowledgeActor(): Promise<KnowledgeActorResult> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return fail(401, "Unauthorized.");
  const db = createSupabaseServiceRoleClient();
  let workspace;
  try {
    workspace = await resolveActiveWorkspaceFromRequest(db, user.id);
  } catch {
    return fail(503, "Workspace unavailable.");
  }
  const access = await assertManagerCommunicationAllowedForWorkspace(db, user.id, workspace.id).catch(() => null);
  if (!access?.allowed) return fail(403, "Communication is not available.");
  return {
    ok: true,
    actor: {
      userId: user.id,
      db,
      workspaceId: workspace.id,
      ownerUserId: workspace.ownerUserId,
      isOwner: workspace.owned,
      allowedPropertyIds: workspace.owned ? null : workspace.propertyIds,
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
