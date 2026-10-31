import { NextResponse } from "next/server";
import { isMissingSchemaError, loadSharedLineConfig } from "@/lib/one-number/config.server";
import type { SharedLineRole } from "@/lib/one-number/contracts";
import { loadThreadPause, pauseThreadAi, resumeThreadAi } from "@/lib/one-number/session.server";
import { resolveCommunicationGrant } from "@/lib/one-number/communication-grant.server";
import { assertManagerCommunicationAllowedForWorkspace } from "@/lib/manager-communication-access.server";
import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { viewerMayActOnSmsProjection } from "@/lib/sms/sms-projection-inbox.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveActiveWorkspaceFromRequest } from "@/lib/workspaces/active.server";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLE_FOR_COUNTERPARTY: Record<string, SharedLineRole | undefined> = {
  prospect: "prospect",
  resident: "resident",
  applicant: "applicant",
  vendor: "vendor",
  unknown: "prospect",
};

type Resolved =
  | { ok: true; workspaceId: string; phoneKey: string; role: SharedLineRole }
  | { ok: false; status: number; error: string };

/**
 * Re-derive everything from the signed-in manager: their ACTIVE workspace (never an id in the body),
 * then require that the conversation belongs to that workspace's owner and carries no other
 * workspace's messages. A conversation id is not authorization.
 */
async function resolveThread(conversationId: string, level: "read" | "edit"): Promise<Resolved & { userId?: string }> {
  if (!UUID.test(conversationId)) return { ok: false, status: 400, error: "Conversation is required." };
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Unauthorized." };
  const db = createSupabaseServiceRoleClient();
  // Per-workspace numbers (today's default) have no shared-line pause: the control is simply absent.
  if ((await loadSharedLineConfig(db)).mode === "per_workspace") return { ok: false, status: 404, error: "Not available." };
  // Role first: resolving the workspace provisions one for an account that has none.
  let manager = false;
  try {
    manager = await userHoldsManagerRole(db, user.id);
  } catch {
    return { ok: false, status: 503, error: "Could not verify your account." };
  }
  if (!manager) return { ok: false, status: 403, error: "Forbidden." };
  const ownerRefusal = await refuseOwnerOnly(db, user.id);
  if (ownerRefusal) return { ok: false, status: ownerRefusal.status, error: "Forbidden." };
  let workspace;
  try {
    workspace = await resolveActiveWorkspaceFromRequest(db, user.id);
  } catch {
    return { ok: false, status: 503, error: "Workspace unavailable." };
  }
  // House membership is not a grant: a teammate needs Communication on the conversation's house.
  const grant = await resolveCommunicationGrant(db, user.id, workspace, level);
  if (!grant.ok) return { ok: false, status: grant.status, error: grant.error };
  const access = await assertManagerCommunicationAllowedForWorkspace(db, user.id, workspace.id).catch(() => null);
  if (!access?.allowed) return { ok: false, status: 403, error: "Communication is not available." };

  const { data: conversation, error } = await db
    .from("sms_projection_conversations")
    .select("id, owner_manager_user_id, counterparty_role, counterparty_phone")
    .eq("id", conversationId)
    .maybeSingle();
  const row = conversation as { owner_manager_user_id?: string; counterparty_role?: string; counterparty_phone?: string } | null;
  if (error || !row || row.owner_manager_user_id !== workspace.ownerUserId) {
    return { ok: false, status: 404, error: "Conversation not found." };
  }
  if (!grant.grant.isOwner) {
    let mayAct = false;
    try {
      mayAct = await viewerMayActOnSmsProjection(db, user.id, conversationId, level);
    } catch {
      return { ok: false, status: 503, error: "Conversation unavailable." };
    }
    if (!mayAct) return { ok: false, status: 403, error: "You do not have access to this conversation." };
  }
  const role = ROLE_FOR_COUNTERPARTY[String(row.counterparty_role ?? "")];
  const phoneKey = normalizeConsentPhone(String(row.counterparty_phone ?? ""));
  if (!role || !phoneKey) return { ok: false, status: 404, error: "Conversation not found." };

  // The owner may run several workspaces: a conversation stamped with another workspace is not this one's.
  const stamped = await db
    .from("sms_projection_turns")
    .select("workspace_id")
    .eq("conversation_id", conversationId)
    .not("workspace_id", "is", null)
    .limit(50);
  if (stamped.error && !isMissingSchemaError(stamped.error)) return { ok: false, status: 503, error: "Conversation unavailable." };
  const workspaces = new Set(((stamped.data ?? []) as Array<{ workspace_id?: string }>).map((r) => String(r.workspace_id ?? "")));
  if (workspaces.size > 0 && !(workspaces.size === 1 && workspaces.has(workspace.id))) {
    return { ok: false, status: 404, error: "Conversation not found." };
  }
  return { ok: true, workspaceId: workspace.id, phoneKey, role, userId: user.id };
}

export async function GET(req: Request) {
  const conversationId = new URL(req.url).searchParams.get("conversationId")?.trim() ?? "";
  const thread = await resolveThread(conversationId, "read");
  if (!thread.ok) return NextResponse.json({ error: thread.error }, { status: thread.status });
  const db = createSupabaseServiceRoleClient();
  const pause = await loadThreadPause(db, thread.phoneKey, thread.workspaceId);
  return NextResponse.json({ paused: Boolean(pause) });
}

/** Body: `{ conversationId, action: "pause" | "resume" }`. */
export async function POST(req: Request) {
  let body: { conversationId?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = body.action === "pause" || body.action === "resume" ? body.action : null;
  if (!action) return NextResponse.json({ error: "Action must be pause or resume." }, { status: 400 });
  const thread = await resolveThread(typeof body.conversationId === "string" ? body.conversationId.trim() : "", "edit");
  if (!thread.ok) return NextResponse.json({ error: thread.error }, { status: thread.status });
  const db = createSupabaseServiceRoleClient();
  const ok =
    action === "pause"
      ? await pauseThreadAi(db, { phoneKey: thread.phoneKey, workspaceId: thread.workspaceId, role: thread.role, reason: "manager_takeover" })
      : await resumeThreadAi(db, { phoneKey: thread.phoneKey, workspaceId: thread.workspaceId, resumedBy: thread.userId! });
  if (!ok) return NextResponse.json({ error: "Could not update this conversation." }, { status: 503 });
  return NextResponse.json({ paused: action === "pause" });
}
