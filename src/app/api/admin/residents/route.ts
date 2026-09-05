import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { deleteAdminPortalAccount } from "@/lib/auth/delete-portal-account";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

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
    const { data: roleRows } = await supabase.from("profile_roles").select("user_id").eq("role", "resident");
    const idsFromRoles = [...new Set((roleRows ?? []).map((r) => r.user_id))];
    const { data: legacyRows } = await supabase.from("profiles").select("id").eq("role", "resident");
    const legacyIds = (legacyRows ?? []).map((p) => p.id);
    const allIds = [...new Set([...idsFromRoles, ...legacyIds])];

    if (allIds.length === 0) {
      return NextResponse.json({ residents: [] });
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, full_name, manager_id, application_approved, created_at")
      .in("id", allIds)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const residents = (data ?? [])
      .filter((p) => !isPortalSandboxEmail(p.email))
      .map((p) => ({
      id: p.id,
      email: p.email ?? "",
      fullName: p.full_name ?? "",
      managerId: p.manager_id ?? "",
      active: p.application_approved !== false,
      joinedAt: p.created_at ?? null,
    }));

    return NextResponse.json({ residents });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    if (!(await requireAdminActor()).ok) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const { id, active } = (await req.json()) as { id: string; active: boolean };
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient();
    const { error } = await supabase.from("profiles").update({ application_approved: active }).eq("id", id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
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

    const result = await deleteAdminPortalAccount(supabase, id);
    return NextResponse.json({ ok: true, mode: result.mode });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
