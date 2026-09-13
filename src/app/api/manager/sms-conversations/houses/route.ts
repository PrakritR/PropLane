import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import {
  fetchManagerSmsConversations,
  resolveSmsScopeManagerIds,
} from "@/lib/manager-sms-messages.server";
import { loadConversationHouseScope, setConversationHousesManually } from "@/lib/sms/conversation-houses.server";
import { canReplaceConversationHouses, loadAssignableConversationHouses } from "@/lib/sms/conversation-house-access.server";
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
export async function GET(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;
  const ownerId = new URL(req.url).searchParams.get("ownerId")?.trim();
  let houses;
  try {
    houses = (await loadAssignableConversationHouses(auth.db, auth.user.id)).assignable;
  } catch {
    return NextResponse.json({ error: "Could not verify house access. Please try again." }, { status: 503 });
  }
  return NextResponse.json(
    {
      houses: [...houses.entries()]
        .filter(([, h]) => !ownerId || h.ownerUserId === ownerId)
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
  const input: unknown = await req.json().catch(() => null);
  const body = input && typeof input === "object" && !Array.isArray(input)
    ? input as { conversationKey?: unknown; propertyIds?: unknown }
    : {};
  const conversationKey = typeof body.conversationKey === "string" ? body.conversationKey.trim() : "";
  const propertyIds = Array.isArray(body.propertyIds) && body.propertyIds.every((id) => typeof id === "string" && id.trim())
    ? [...new Set((body.propertyIds as string[]).map((id) => id.trim()))]
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
  const ownerId = String(thread.ownerManagerUserId ?? "").trim();
  if (!ownerId) return NextResponse.json({ error: "Could not verify this workspace." }, { status: 503 });
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

  const memberKeys = [...new Set([thread.conversationKey ?? conversationKey, ...(thread.memberKeys ?? [])])];
  let accessRevision: string;
  let expectedTags: Awaited<ReturnType<typeof loadConversationHouseScope>>;
  try {
    const revision = await auth.db.rpc("conversation_house_access_revision", { p_actor: auth.user.id });
    if (revision.error || typeof revision.data !== "string") throw new Error("Access unavailable");
    accessRevision = revision.data;
    expectedTags = await loadConversationHouseScope(auth.db, ownerId, memberKeys);
    const access = await loadAssignableConversationHouses(auth.db, auth.user.id);
    if (!canReplaceConversationHouses({
      viewerId: auth.user.id,
      ownerId,
      currentIds: expectedTags.map((house) => house.property_id),
      nextIds: propertyIds,
      ...access,
    })) {
      return NextResponse.json({ error: "Your access does not allow this house assignment. Refresh and try again." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Could not verify house access. Please try again." }, { status: 503 });
  }

  const ok = await setConversationHousesManually(auth.db, {
    managerUserId: ownerId,
    conversationKey: thread.conversationKey ?? conversationKey,
    propertyIds,
    taggedByUserId: auth.user.id,
    memberKeys, expectedTags, accessRevision,
  });
  if (!ok) return NextResponse.json({ error: "Could not save the houses for this conversation." }, { status: 503 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
}
