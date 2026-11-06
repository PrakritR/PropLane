import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createVendorInviteDraft } from "@/lib/vendor-invite.server";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;


export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      vendorId?: string;
      vendorName?: string;
      vendorEmail?: string;
    };
    const vendorId = String(body.vendorId ?? "").trim();
    const vendorName = String(body.vendorName ?? "").trim();
    const vendorEmail = String(body.vendorEmail ?? "").trim().toLowerCase();

    if (!vendorId) return NextResponse.json({ error: "vendorId is required." }, { status: 400 });
    if (!vendorEmail || !EMAIL_RE.test(vendorEmail)) {
      return NextResponse.json({ error: "A valid vendor email is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("full_name, email").eq("id", user.id).maybeSingle();
    const { data: roles, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", user.id);
    if (roleError || !(roles ?? []).some((row) => row.role === "manager" || row.role === "admin")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const managerName = profile?.full_name?.trim() || profile?.email?.trim() || "Your property manager";
    const result = await createVendorInviteDraft(db, {
      managerUserId: user.id,
      managerName,
      vendorId,
      vendorEmail,
      vendorName,
      origin: resolveAppOrigin(req),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      ok: true,
      linkUrl: result.draft.linkUrl,
      subject: result.draft.subject,
      body: result.draft.text,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to prepare vendor invite." },
      { status: 500 },
    );
  }
}
