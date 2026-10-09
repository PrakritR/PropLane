import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { deleteVendorAccount } from "@/lib/auth/delete-portal-account";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { setAdminAccountActive } from "@/lib/admin/admin-account-active.server";

export const runtime = "nodejs";

async function requireAdminActor(): Promise<{ ok: true; actorId: string } | { ok: false }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await isAdminUser(user.id))) return { ok: false };
  return { ok: true, actorId: user.id };
}

export async function GET() {
  try {
    if (!(await requireAdminActor()).ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const supabase = createSupabaseServiceRoleClient();
    const { data: roleRows } = await supabase.from("profile_roles").select("user_id").eq("role", "vendor");
    const idsFromRoles = [...new Set((roleRows ?? []).map((r) => r.user_id))];
    const { data: legacyRows } = await supabase.from("profiles").select("id").eq("role", "vendor");
    const legacyIds = (legacyRows ?? []).map((p) => p.id);
    const allIds = [...new Set([...idsFromRoles, ...legacyIds])];

    if (allIds.length === 0) {
      return NextResponse.json({ vendors: [] });
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, full_name, manager_id, application_approved, created_at")
      .in("id", allIds)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const vendors = (data ?? [])
      .filter((p) => !isPortalSandboxEmail(p.email))
      .map((p) => ({
        id: p.id,
        email: p.email ?? "",
        fullName: p.full_name ?? "",
        managerId: p.manager_id ?? "",
        active: p.application_approved !== false,
        joinedAt: p.created_at ?? null,
      }));

    return NextResponse.json({ vendors });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAdminActor();
    if (!auth.ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const body = (await req.json().catch(() => ({}))) as { id?: string; active?: unknown; reason?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (typeof body.active !== "boolean") {
      return NextResponse.json({ error: "active must be true or false." }, { status: 400 });
    }

    // Disabling or re-enabling somebody's access is audited with the staff member's reason, the
    // same as a manager's — the one popup that collects it posts to all three routes.
    const outcome = await setAdminAccountActive({
      db: createSupabaseServiceRoleClient(),
      actorUserId: auth.actorId,
      accountUserId: id,
      kind: "vendor",
      active: body.active,
      reason: body.reason,
    });
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true, auditRecorded: outcome.auditRecorded });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAdminActor();
    if (!auth.ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const { id } = (await req.json()) as { id?: string };
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient();
    if (id === auth.actorId && !(await userHoldsAdminRole(supabase, auth.actorId))) {
      return NextResponse.json({ error: "You cannot delete your own account while signed in." }, { status: 400 });
    }

    const result = await deleteVendorAccount(supabase, id);
    return NextResponse.json({ ok: true, mode: result.mode });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
