import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { ACTIVE_PORTAL_COOKIE } from "@/lib/auth/portal-access";
import { ensureSignedInResidentAccount } from "@/lib/auth/ensure-signed-in-resident.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function safeResidentRedirect(raw: unknown): string {
  if (typeof raw !== "string") return "/resident/applications/apply";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/resident") || trimmed.startsWith("//")) {
    return "/resident/applications/apply";
  }
  return trimmed;
}

/**
 * Add the RESIDENT role to the already-signed-in account, additively.
 *
 * One person can hold manager / resident / vendor roles on a single login: a
 * manager (or vendor) who wants to rent a home creates a resident account here
 * WITHOUT a second email and WITHOUT losing their existing role. The write:
 *
 *  - takes the user id from the authenticated session only (never from the
 *    request body), so it can only ever add a role to the caller's own account;
 *  - is additive and idempotent — it inserts the `resident` profile_roles row
 *    (composite PK makes a repeat a no-op) and never removes another role;
 *  - preserves the legacy `profiles.role` precedence via
 *    `primaryRoleWhenAddingResident` (a manager stays a manager), and only
 *    writes that column when it would actually change, so a manager's profile
 *    (including their `manager_id`) is left untouched;
 *  - flips the active-portal cookie to `resident` so the caller lands in the
 *    resident portal. The portal switcher moves them back to the manager side
 *    without signing out.
 *
 * Optional JSON body: `{ redirectTo?: string; contactEmail?: string; phone?: string }`.
 */
export async function POST(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await serverClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      redirectTo?: string;
      contactEmail?: string;
      phone?: string;
    };
    const redirectTo = safeResidentRedirect(body.redirectTo);
    const contactEmail = typeof body.contactEmail === "string" ? body.contactEmail.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";

    const service = createSupabaseServiceRoleClient();
    const recovery = await recoverySetupRedirect(service, user.id);
    if (recovery) return NextResponse.json({ ok: true, recoveryRequired: true, redirectTo: recovery });
    const ensured = await ensureSignedInResidentAccount(service, user, {
      contactEmail: contactEmail || undefined,
      phone: phone || undefined,
    });
    if (!ensured.ok) {
      return NextResponse.json({ error: ensured.error }, { status: 500 });
    }

    track("resident_account_created", user.id, {
      source: ensured.createdResidentRole ? "signed_in_promote" : "signed_in_resident_refresh",
    });

    const res = NextResponse.json({ ok: true, redirectTo });
    const secure = process.env.NODE_ENV === "production";
    res.cookies.set(ACTIVE_PORTAL_COOKIE, "resident", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      secure,
    });
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create resident account.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
