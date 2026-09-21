import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendVendorInvite } from "@/lib/vendor-invite.server";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

// Domain matched as dot-separated labels (no char-class overlap with the "." delimiter)
// so there is exactly one way to parse a match — avoids polynomial backtracking.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function canSendVendorInvite(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

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
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Vendor access is unavailable for this account." }, { status: 403 });
    }
    const { data: profile } = await db.from("profiles").select("role, full_name, email").eq("id", user.id).maybeSingle();
    if (!canSendVendorInvite(profile?.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const managerName = profile?.full_name?.trim() || profile?.email?.trim() || "Your property manager";
    const result = await sendVendorInvite(db, {
      managerUserId: user.id,
      managerName,
      vendorId,
      vendorEmail,
      vendorName,
      origin: resolveAppOrigin(req),
    });

    if (!result.ok) {
      if (result.status === 502 || result.status === 503) {
        return NextResponse.json(
          { ok: false, error: result.error, mailtoHref: result.mailtoHref, linkUrl: result.linkUrl },
          { status: result.status },
        );
      }
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ ok: true, id: result.emailId, linkUrl: result.linkUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to send invite." }, { status: 500 });
  }
}
