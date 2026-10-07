import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadVendorQuickReplies, saveVendorQuickReplies } from "@/lib/vendor-quick-replies.server";
import { normalizeVendorQuickReplies } from "@/lib/vendor-quick-replies";

export const runtime = "nodejs";

/**
 * The vendor's own quick replies. Every read and write is pinned to the
 * authenticated vendor's user id — no id in the body or query is trusted.
 * GET returns the starter set until the vendor saves a list of their own.
 */
async function requireVendor() {
  const access = await resolveVendorPortalUserId();
  if (!access.ok) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status }),
    };
  }
  return { ok: true as const, userId: access.userId, db: createSupabaseServiceRoleClient() };
}

export async function GET() {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;
    const result = await loadVendorQuickReplies(auth.db, auth.userId);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load quick replies." }, { status: 500 });
  }
}

/** Replace the whole list (add / edit / delete / reorder all land as one save). */
export async function PUT(req: Request) {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;
    const body = (await req.json().catch(() => null)) as { replies?: unknown } | null;
    if (!body || normalizeVendorQuickReplies(body.replies) === null) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    const replies = await saveVendorQuickReplies(auth.db, auth.userId, body.replies);
    return NextResponse.json({ replies, isStarterSet: false });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to save quick replies." }, { status: 500 });
  }
}
