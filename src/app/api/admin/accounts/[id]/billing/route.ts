import { NextResponse } from "next/server";
import { isAdminAccountId } from "@/lib/admin/admin-account-detail.server";
import { loadAdminAccountBilling } from "@/lib/admin/admin-account-billing.server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * GET /api/admin/accounts/[id]/billing — one manager account's billing: the subscription facts,
 * trial and discount terms, limits, "paid to date" and the payments Stripe has taken from the
 * customer (invoices, read server-side with the platform key).
 *
 * Admin-only (401 / 403), service-role reads. The id is a path parameter and therefore NOT
 * authorization: it must be a UUID, and what comes back is scoped to that one account. Stripe being
 * unreachable is a field (`stripe.available`), not an error; a failure here never returns the
 * underlying message.
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
    const billing = await loadAdminAccountBilling(createSupabaseServiceRoleClient(), id);
    return NextResponse.json(billing, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("GET /api/admin/accounts/[id]/billing failed", e);
    return NextResponse.json({ error: "Could not load this account's billing." }, { status: 500 });
  }
}
