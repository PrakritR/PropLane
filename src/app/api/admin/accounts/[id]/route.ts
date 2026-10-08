import { NextResponse } from "next/server";
import { isAdminAccountId, loadAdminAccountDetail } from "@/lib/admin/admin-account-detail.server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * GET /api/admin/accounts/[id] — one account's record: roles, workspaces,
 * billing basis, payments, communication log, audit trail and support.
 *
 * Admin-only (401 / 403), service-role reads. The id is a path parameter and
 * therefore NOT authorization: it must be a UUID and the profile must exist
 * before anything else is read. Never returns password or auth secrets.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    const { id: rawId } = await ctx.params;
    const id = decodeURIComponent(rawId ?? "").trim();
    if (!isAdminAccountId(id)) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    const detail = await loadAdminAccountDetail(createSupabaseServiceRoleClient(), id);
    if (!detail) return NextResponse.json({ error: "Account not found." }, { status: 404 });
    return NextResponse.json(detail, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
