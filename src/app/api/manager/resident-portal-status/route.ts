import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export async function POST(req: Request) {
  try {
    const ctx = await getPortalAccessContext();
    if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!hasAdminRole(ctx) && !hasRole(ctx, "manager")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json()) as { emails?: unknown[] };
    const requested = [...new Set((body.emails ?? []).map(normalizeEmail).filter(Boolean))];
    if (requested.length === 0) return NextResponse.json({ statuses: [] });

    const db = createSupabaseServiceRoleClient();
    const { data: profiles, error } = await db
      .from("profiles")
      .select("id, email")
      .in("email", requested);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const statuses = await Promise.all(
      (profiles ?? []).map(async (profile) => {
        if (!profile.id || !profile.email) return null;
        const { data: authData } = await db.auth.admin.getUserById(profile.id);
        const meta = authData.user?.user_metadata as Record<string, unknown> | undefined;
        // auto_provisioned_resident=true means the account was created on approval and the resident has not set up their own sign-in yet
        const autoProvisioned = meta?.auto_provisioned_resident === true;
        const passwordClaimed = Boolean(meta?.resident_password_claimed_at);
        return {
          email: normalizeEmail(profile.email),
          portalSetup: !autoProvisioned || passwordClaimed,
        };
      }),
    );

    return NextResponse.json({ statuses: statuses.filter(Boolean) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load portal statuses.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
