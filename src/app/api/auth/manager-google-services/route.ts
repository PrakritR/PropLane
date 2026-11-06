import { NextResponse } from "next/server";

import {
  dismissGoogleServicesOnboarding,
  loadGoogleServicesOnboardingStatus,
} from "@/lib/auth/manager-google-services-onboarding.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function requireManager() {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: roles, error } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  if (error) return null;
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const isManager = roleList.includes("manager") || roleList.includes("admin");
  if (!isManager) return null;
  return { db, userId: user.id };
}

export async function GET() {
  try {
    const ctx = await requireManager();
    if (!ctx) {
      return NextResponse.json({ error: "Managers only." }, { status: 403 });
    }
    const status = await loadGoogleServicesOnboardingStatus(ctx.db, ctx.userId);
    return NextResponse.json(status);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load Google services status.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) {
      return NextResponse.json({ error: "Managers only." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "skip") {
      return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
    }
    await dismissGoogleServicesOnboarding(ctx.db, ctx.userId);
    return NextResponse.json({ ok: true, dismissed: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not update onboarding.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
