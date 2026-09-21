import { NextResponse } from "next/server";
import { normalizeCoManagerPermissions } from "@/lib/co-manager-permissions";
import {
  transferWorkspaceOwnership,
  type WorkspaceOwnershipAfterRole,
} from "@/lib/workspace-ownership-transfer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const AFTER_ROLES: WorkspaceOwnershipAfterRole[] = ["admin", "property_manager", "viewer", "custom", "nothing"];

function parseAfterRole(value: unknown): WorkspaceOwnershipAfterRole {
  return typeof value === "string" && (AFTER_ROLES as string[]).includes(value)
    ? (value as WorkspaceOwnershipAfterRole)
    : "admin";
}

export async function POST(req: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await ctx.params;
    const id = workspaceId?.trim() ?? "";
    if (!id) {
      return NextResponse.json({ error: "workspaceId is required." }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as {
      newOwnerUserId?: string;
      formerOwnerRole?: string;
      formerOwnerPermissions?: unknown;
    } | null;

    const newOwnerUserId = body?.newOwnerUserId?.trim() ?? "";
    if (!newOwnerUserId) {
      return NextResponse.json({ error: "newOwnerUserId is required." }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const svc = createSupabaseServiceRoleClient();
    // ids in the body are never authorization: currentOwnerUserId always
    // comes from the authenticated session, never from what the caller sent.
    const result = await transferWorkspaceOwnership(svc, {
      workspaceId: id,
      currentOwnerUserId: user.id,
      newOwnerUserId,
      formerOwnerRole: parseAfterRole(body?.formerOwnerRole),
      formerOwnerPermissions: normalizeCoManagerPermissions(body?.formerOwnerPermissions),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      ok: true,
      houses: result.houses,
      members: result.members,
      workspaceName: result.workspaceName,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
