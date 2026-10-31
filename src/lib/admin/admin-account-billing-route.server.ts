import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminAccountId } from "@/lib/admin/admin-account-detail.server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

const NO_STORE = { "Cache-Control": "private, no-store" };

export type AdminBillingRouteTarget = {
  db: SupabaseClient;
  actorUserId: string;
  managerUserId: string;
  body: Record<string, unknown>;
};

/** True only for an account with a stored manager role. */
async function isManagerAccount(db: SupabaseClient, userId: string): Promise<boolean | null> {
  const roles = await db.from("profile_roles").select("role").eq("user_id", userId);
  if (roles.error) return null;
  const rows = (roles.data ?? []) as { role?: string | null }[];
  return rows.some((r) => String(r.role ?? "").trim().toLowerCase() === "manager");
}

/**
 * The shared front door of the staff money routes (`billing/price|refund|cancel`):
 *  - `requireAdminRoute()` = Overall admin (the `admin` role). A workspace admin, a PropLane-issued
 *    seat holder, a manager and a signed-out caller never reach Stripe (403 / 401).
 *  - the path id is a name, never a grant: it must be a UUID and a MANAGER account (404 otherwise),
 *    and an unreadable role is a 500, never "probably a manager".
 *  - the body must be a JSON object.
 * The reason is NOT checked here; the action refuses a missing one before any Stripe call.
 */
export async function resolveAdminBillingTarget(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<{ ok: true; target: AdminBillingRouteTarget } | { ok: false; response: NextResponse }> {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate;
  const { id: rawId } = await ctx.params;
  const id = decodeURIComponent(rawId ?? "").trim();
  if (!isAdminAccountId(id)) {
    return { ok: false, response: NextResponse.json({ error: "Account not found." }, { status: 404, headers: NO_STORE }) };
  }
  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE }) };
  }
  const db = createSupabaseServiceRoleClient();
  const manager = await isManagerAccount(db, id);
  if (manager === null) {
    return { ok: false, response: NextResponse.json({ error: "Could not verify this account." }, { status: 500, headers: NO_STORE }) };
  }
  if (!manager) {
    return { ok: false, response: NextResponse.json({ error: "Account not found." }, { status: 404, headers: NO_STORE }) };
  }
  return { ok: true, target: { db, actorUserId: gate.userId, managerUserId: id, body: body as Record<string, unknown> } };
}
