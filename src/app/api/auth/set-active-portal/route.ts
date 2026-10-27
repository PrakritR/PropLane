import { NextResponse } from "next/server";
import type { AuthRole } from "@/components/auth/portal-switcher";
import { LEGACY_PREVIEW_UID_COOKIE_NAME, PREVIEW_PORTAL_COOKIE, PREVIEW_UID_COOKIE } from "@/lib/auth/admin-preview";
import { LAST_PORTAL_COOKIE, lastPortalCookieOptions } from "@/lib/auth/last-portal";
import { ACTIVE_PORTAL_COOKIE, getPortalAccessContext, isPortalRoleReachable } from "@/lib/auth/portal-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadPropertyPortalWorkspaceId, loadServiceStaffIds } from "@/lib/service/service-mode.server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import { cookies } from "next/headers";

export const runtime = "nodejs";

function isAuthRole(value: string): value is AuthRole {
  return value === "resident" || value === "manager" || value === "admin" || value === "vendor";
}

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const { role, keepWorkspace } = (await req.json()) as { role?: string; keepWorkspace?: boolean };
    if (!role || !isAuthRole(role)) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    }

    const ctx = await getPortalAccessContext();
    // Reachability, not bare membership: a production admin identity holds the
    // manager role but must not be able to switch into the property portal.
    if (!isPortalRoleReachable(ctx, role)) {
      return NextResponse.json({ error: "You do not have access to this portal." }, { status: 403 });
    }

    const res = NextResponse.json({ ok: true });
    const secure = process.env.NODE_ENV === "production";
    // Cookie hazard: the workspace cookie may still name a PropLane Service workspace this account is staff of (left
    // by Admin > Service > Open). Landing in the Property portal on it would render service mode, so a plain switch to
    // the manager portal drops that selection (the portal then falls to the account's own workspace). Opening a service
    // workspace itself passes `keepWorkspace` because the cookie was just set on purpose.
    if (role === "manager" && keepWorkspace !== true) {
      const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value?.trim();
      const db = createSupabaseServiceRoleClient();
      const staff = selected ? await loadServiceStaffIds(db, user.id) : { ids: new Set<string>(), failed: false };
      // A staff read that failed drops the selection too: it cannot be proved NOT to name a service
      // workspace, and landing in the Property portal on one would render service mode.
      if (selected && (staff.failed || staff.ids.has(selected))) {
        const own = await loadPropertyPortalWorkspaceId(db, user.id);
        res.cookies.set(WORKSPACE_COOKIE, own ?? "", {
          httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: own ? 60 * 60 * 24 * 365 : 0,
        });
      }
    }
    res.cookies.set(ACTIVE_PORTAL_COOKIE, role, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      secure,
    });
    // The device remembers the portal it opened last; a multi-role sign-in reopens it (post-sign-in-destination.server.ts).
    res.cookies.set(LAST_PORTAL_COOKIE, role, lastPortalCookieOptions(secure));
    res.cookies.set(PREVIEW_UID_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure });
    res.cookies.set(PREVIEW_PORTAL_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure });
    res.cookies.set(LEGACY_PREVIEW_UID_COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure });
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
