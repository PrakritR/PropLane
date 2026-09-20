import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { PREVIEW_PORTAL_COOKIE, PREVIEW_UID_COOKIE } from "@/lib/auth/admin-preview";
import { ACTIVE_PORTAL_COOKIE } from "@/lib/auth/portal-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";

export const runtime = "nodejs";

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    const signOutUserId = currentUser?.id;
    await supabase.auth.signOut();
    if (signOutUserId) track("user_signed_out", signOutUserId);

    const res = NextResponse.json({ ok: true });
    const secure = process.env.NODE_ENV === "production";
    const clear = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 0, secure };
    res.cookies.set(ACTIVE_PORTAL_COOKIE, "", clear);
    res.cookies.set(PREVIEW_UID_COOKIE, "", clear);
    res.cookies.set(PREVIEW_PORTAL_COOKIE, "", clear);
    // The selected workspace is per-signed-in-account state. Leaving it set
    // let the NEXT person to sign in on this browser land inside whichever
    // workspace the previous account last selected (a wrong-workspace 403 on
    // "Add property" until they switched, or worse, a stale write target).
    res.cookies.set(WORKSPACE_COOKIE, "", clear);
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sign out failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
