import { NextResponse } from "next/server";
import {
  RESIDENT_WELCOME_EMAIL_RE,
  canSendResidentWelcome,
  deliverResidentWelcome,
} from "@/lib/resident-welcome.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    let body: { to?: unknown; residentName?: unknown; axisId?: unknown };
    try {
      body = (await req.json()) as { to?: unknown; residentName?: unknown; axisId?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const to = normalizeEmail(body.to);
    const residentName = typeof body.residentName === "string" ? body.residentName.trim() : "";
    const axisId = typeof body.axisId === "string" ? body.axisId.trim() : "";

    if (!to || !RESIDENT_WELCOME_EMAIL_RE.test(to)) {
      return NextResponse.json({ error: "A valid recipient email is required." }, { status: 400 });
    }
    if (!axisId) {
      return NextResponse.json({ error: "Axis ID is required." }, { status: 400 });
    }

    const svc = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, svc)).kind === "denied") {
      return NextResponse.json({ error: "Resident access is unavailable for this account." }, { status: 403 });
    }
    const { data: requestor, error: requestorError } = await svc
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (requestorError || !requestor) {
      return NextResponse.json({ error: requestorError?.message ?? "Profile not found." }, { status: 403 });
    }

    if (!canSendResidentWelcome(requestor.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const result = await deliverResidentWelcome(
      svc,
      { userId: user.id, email: user.email ?? null },
      { to, residentName: residentName || undefined, axisId },
    );

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, mailtoHref: result.mailtoHref },
        { status: result.status },
      );
    }

    return NextResponse.json({ ok: true, id: result.id, skipped: result.skipped });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send welcome email." },
      { status: 500 },
    );
  }
}
