import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTestWorkspacePrincipalCompatibility, resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/**
 * Who may look an applicant up, from STORED `profile_roles` rows only.
 *
 * It used to read the legacy singular `profiles.role`, which refused a manager who holds the
 * stored row but was created as a resident (how the team dogfoods) and admitted a legacy-only
 * `manager` with no stored row that every converted route already locks out. The retired `owner` /
 * `pro` labels only ever existed in that column.
 */
function canLookUpApplicants(storedRoles: readonly string[]): boolean {
  return storedRoles.includes("admin") || storedRoles.includes("manager");
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
    const { data: roleRows, error: roleError } = await svc.from("profile_roles").select("role").eq("user_id", user.id);
    // An unreadable role list grants nothing.
    if (roleError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!canLookUpApplicants((roleRows ?? []).map((row) => String(row.role ?? "").trim().toLowerCase()))) {
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
