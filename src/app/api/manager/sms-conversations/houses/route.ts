import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import {
  fetchManagerSmsConversations,
  loadWorkspaceHouseLabels,
  resolveSmsScopeManagerIds,
} from "@/lib/manager-sms-messages.server";
import { setConversationHousesManually } from "@/lib/sms/conversation-houses.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireManager() {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
    return { error: NextResponse.json({ error: "Manager access required." }, { status: 403 }) };
  }
  return { user: ctx.user, db: createSupabaseServiceRoleClient() };
}

/** The houses a thread can be assigned to: every house in the viewer's Communication scope. */
export async function GET() {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const scope = await resolveSmsScopeManagerIds(auth.db, auth.user.id);
  const houses = await loadWorkspaceHouseLabels(auth.db, scope);
  return NextResponse.json(
    {
      houses: [...houses.entries()]
        .map(([propertyId, h]) => ({ propertyId, label: h.label, ownerUserId: h.ownerUserId }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * Set a thread's house(s) by hand. Replaces every automatic tag; an empty list
 * clears the thread back to untagged. The thread must be visible to the
 * viewer, the viewer needs Communication at edit on its owner, and every house
 * must belong to that owner — ids in a body are never authorization.
 */
export async function PATCH(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as { conversationKey?: unknown; propertyIds?: unknown };
  const conversationKey = typeof body.conversationKey === "string" ? body.conversationKey.trim() : "";
  const propertyIds = Array.isArray(body.propertyIds)
    ? [...new Set(body.propertyIds.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))]
    : null;
  if (!conversationKey || !propertyIds) {
    return NextResponse.json({ error: "conversationKey and propertyIds are required." }, { status: 400 });
  }
  if (propertyIds.length > 20) {
    return NextResponse.json({ error: "Too many houses for one conversation." }, { status: 400 });
  }

  const payload = await fetchManagerSmsConversations(auth.db, auth.user.id);
  const thread = payload.residents.find(
    (row) => row.conversationKey === conversationKey || (row.memberKeys ?? []).includes(conversationKey),
  );
  if (!thread) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const ownerId = String(thread.ownerManagerUserId ?? auth.user.id).trim();
  if (ownerId !== auth.user.id) {
    const editScope = await resolveSmsScopeManagerIds(auth.db, auth.user.id, "edit");
    if (!editScope.includes(ownerId)) {
      return NextResponse.json({ error: "You do not have edit access to this conversation." }, { status: 403 });
    }
  }
  if (propertyIds.length > 0) {
    const ownership = await findPropertyIdsNotOwnedByManager(auth.db, ownerId, propertyIds);
    // Unknown ownership is not ownership: refuse rather than tag a stranger's house.
    if (!ownership.ok) return NextResponse.json({ error: "Could not verify those houses." }, { status: 503 });
    if (ownership.unowned.length > 0) {
      return NextResponse.json({ error: "One of those houses is not in this workspace." }, { status: 403 });
    }
  }

  const ok = await setConversationHousesManually(auth.db, {
    managerUserId: ownerId,
    conversationKey: thread.conversationKey ?? conversationKey,
    propertyIds,
    taggedByUserId: auth.user.id,
  });
  if (!ok) return NextResponse.json({ error: "Could not save the houses for this conversation." }, { status: 503 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
}
