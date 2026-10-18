import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  createDraftPolicy,
  listPoliciesForWorkspace,
  type AdminActor,
} from "@/lib/owner-management/policies.server";
import { parseTermsBody, policyErrorResponse, presentPolicy } from "@/lib/owner-management/policies-api.server";

export const runtime = "nodejs";

async function gate(): Promise<AdminActor | NextResponse> {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  return { role: "admin", userId: admin.userId };
}

/** GET: a managed workspace's fee policies (newest first) and the people on its team who can be the owner of record. */
export async function GET(_req: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const actor = await gate();
  if (actor instanceof NextResponse) return actor;
  const { workspaceId } = await context.params;
  const db = createSupabaseServiceRoleClient();
  try {
    const policies = await listPoliciesForWorkspace(db, workspaceId);
    const { data: invites } = await db
      .from("account_link_invites")
      .select("invitee_user_id, invitee_display_name")
      .eq("workspace_id", workspaceId)
      .eq("status", "accepted");
    const ids = [...new Set(((invites ?? []) as Array<{ invitee_user_id: string }>).map((i) => String(i.invitee_user_id)))];
    const { data: profiles } = ids.length ? await db.from("profiles").select("id, email, full_name").in("id", ids) : { data: [] };
    const people = ((profiles ?? []) as Array<{ id: string; email?: string; full_name?: string }>).map((p) => ({
      userId: String(p.id), name: String(p.full_name || p.email || "Team member"), email: String(p.email ?? ""),
    }));
    const nameOf = new Map(people.map((p) => [p.userId, p.name]));
    return NextResponse.json({ policies: policies.map((p) => presentPolicy(p, nameOf.get(p.ownerUserId) ?? "")), people });
  } catch (e) {
    return policyErrorResponse(e, "Could not load fee policies.");
  }
}

/** POST { ownerUserId, effectiveFrom, ...terms }: draft a fee policy version. Admin only. */
export async function POST(req: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const actor = await gate();
  if (actor instanceof NextResponse) return actor;
  const { workspaceId } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const terms = parseTermsBody(body);
  if (!terms) return NextResponse.json({ error: "Check the fee amounts." }, { status: 400 });
  try {
    const row = await createDraftPolicy(createSupabaseServiceRoleClient(), actor, {
      workspaceId,
      ownerUserId: String(body.ownerUserId ?? "").trim(),
      terms,
      effectiveFrom: String(body.effectiveFrom ?? "").trim(),
    });
    return NextResponse.json({ policy: presentPolicy(row) }, { status: 201 });
  } catch (e) {
    return policyErrorResponse(e, "Could not save the fee policy.");
  }
}
