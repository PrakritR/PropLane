import { NextResponse } from "next/server";

import { resolveAgentContext } from "@/lib/tools/context";

export const runtime = "nodejs";

/**
 * List the signed-in manager's OPEN agent-proposed write actions so the
 * dashboard can surface each as an approvable "AI draft" chip. Owner-scoped by
 * `user_id` (the same key `claimPendingAction` claims on — NOT `landlord_id`,
 * which two residents of one manager share), PORTAL-scoped to "manager" (a
 * dual-role user's resident/vendor proposals are confirmable only from their
 * own portal, so listing them here would offer an approval that the
 * portal-bound confirm gate must refuse), and limited to still-valid
 * proposals. Read-only: approving/denying goes through `/api/agent/chat`, which
 * runs the `claimPendingAction` re-validation + handler. This route never
 * returns the stored tool input — only the preview the manager already vetoes.
 */
export async function GET() {
  const ctx = await resolveAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const nowIso = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("agent_pending_actions")
    .select("id, tool_name, preview, created_at")
    .eq("user_id", ctx.userId)
    .eq("portal", "manager")
    .eq("status", "proposed")
    .is("sms_test_actor_user_id", null)
    .is("sms_test_manager_user_id", null)
    .is("sms_test_session_id", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[agent/pending-actions] list failed:", error);
    return NextResponse.json({ error: "Could not load pending actions." }, { status: 500 });
  }

  const actions = (data ?? []).map((row) => ({
    id: String(row.id),
    toolName: String(row.tool_name),
    preview: row.preview,
    createdAt: row.created_at ? String(row.created_at) : null,
  }));

  return NextResponse.json({ actions });
}
