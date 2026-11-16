import { NextResponse } from "next/server";
import { handleAssistantReviewGet, handleAssistantReviewPost } from "@/lib/assistant-review/route.server";
import type { ReviewActor } from "@/lib/assistant-review/store.server";
import { loadServiceInboxScope } from "@/lib/manager-sms-messages.server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assistant quality management from admin Communication. Admin only (`requirePlatformAdmin`). `?workspaceId=` / body
 * `workspaceId` is a NAME: it must be a PropLane Service workspace this admin surface already reads (else 404), and its
 * owner is read from the workspace row, never from the request.
 */
async function resolveActor(workspaceIdRaw: string): Promise<{ actor: ReviewActor } | { response: NextResponse }> {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return { response: NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status }) };
  const workspaceId = workspaceIdRaw.trim().toLowerCase();
  if (!UUID.test(workspaceId)) return { response: NextResponse.json({ error: "Pick a workspace." }, { status: 400 }) };
  const db = createSupabaseServiceRoleClient();
  const scope = await loadServiceInboxScope(db);
  if (!scope.workspaceIds.map((w) => w.toLowerCase()).includes(workspaceId)) {
    return { response: NextResponse.json({ error: "Workspace not found." }, { status: 404 }) };
  }
  const { data } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  const ownerUserId = String((data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "").trim();
  if (!ownerUserId) return { response: NextResponse.json({ error: "Workspace not found." }, { status: 404 }) };
  return { actor: { db, userId: admin.userId, workspaceId, ownerUserId } };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const resolved = await resolveActor(url.searchParams.get("workspaceId") ?? "");
  if ("response" in resolved) return resolved.response;
  return handleAssistantReviewGet(resolved.actor, url);
}

export async function POST(request: Request) {
  const cloned = request.clone();
  const body = (await cloned.json().catch(() => ({}))) as { workspaceId?: unknown };
  const resolved = await resolveActor(typeof body.workspaceId === "string" ? body.workspaceId : "");
  if ("response" in resolved) return resolved.response;
  return handleAssistantReviewPost(resolved.actor, request);
}
