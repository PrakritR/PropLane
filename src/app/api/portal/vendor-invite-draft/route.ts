import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createVendorInviteDraft } from "@/lib/vendor-invite.server";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** profile_roles-aware: "owner" folds into manager; a multi-role account created as resident still qualifies. */
async function canSendVendorInvite(): Promise<boolean> {
  const ctx = await getPortalAccessContext();
  return hasRole(ctx, "manager") || hasRole(ctx, "admin") || String(ctx.profile?.role ?? "").toLowerCase() === "pro";
}

/** Mint a vendor onboarding invite link + message copy without sending email. */
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
    const { data: profile } = await db.from("profiles").select("role, full_name, email").eq("id", user.id).maybeSingle();
    if (!(await canSendVendorInvite())) {
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
