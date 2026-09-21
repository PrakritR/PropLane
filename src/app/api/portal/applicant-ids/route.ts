import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTestWorkspacePrincipalCompatibility, resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

function canLookUpApplicants(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const email = searchParams.get("email")?.trim().toLowerCase() ?? "";
    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const svc = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, svc)).kind === "denied") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { data: requestor } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (!canLookUpApplicants(requestor?.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: profile } = await svc
      .from("profiles")
      .select("id, manager_id")
      .eq("email", email)
      .maybeSingle();

    // Normal accounts never discover private identities, while a classified
    // manager may look up only a member of its own namespace.
    await assertTestWorkspacePrincipalCompatibility({
      actorUserId: user.id,
      relatedUserIds: profile?.id ? [String(profile.id)] : [],
      db: svc,
    });

    const axisId = profile?.manager_id?.trim() || null;
    return NextResponse.json({ axisId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lookup failed" },
      { status: 500 },
    );
  }
}
