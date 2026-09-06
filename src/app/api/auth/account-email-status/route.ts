import { NextResponse } from "next/server";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    if (!(await rateLimit(`account-email-status:${clientIpFrom(req)}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const url = new URL(req.url);
    const email = url.searchParams.get("email")?.trim().toLowerCase() ?? "";
    if (!email || !email.includes("@")) {
      return NextResponse.json({ exists: false, roles: [] as string[] });
    }

    const supabase = createSupabaseServiceRoleClient();
    const userId = await findAuthUserIdByEmail(supabase, email);
    if (!userId) {
      return NextResponse.json({ exists: false, roles: [] as string[] });
    }

    const roles = new Set<string>();

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
    const primaryRole = typeof profile?.role === "string" ? profile.role.trim().toLowerCase() : "";
    if (primaryRole) roles.add(primaryRole);

    const { data: roleRows } = await supabase.from("profile_roles").select("role").eq("user_id", userId);
    for (const row of roleRows ?? []) {
      const role = typeof row.role === "string" ? row.role.trim().toLowerCase() : "";
      if (role) roles.add(role);
    }

    const sortedRoles = [...roles].sort();

    return NextResponse.json({
      exists: true,
      roles: sortedRoles,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
