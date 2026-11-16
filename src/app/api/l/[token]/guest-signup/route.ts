import { NextResponse } from "next/server";
import { completeGuestSignup } from "@/lib/guest-signup-link/complete.server";
import { isGuestSignupTarget } from "@/lib/guest-signup-link/model";
import { allowLinkRequest, expiredLinkResponse } from "@/lib/one-number/link-http.server";
import { resolvePhoneBoundLink } from "@/lib/one-number/links.server";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Finish a guest sign-in link (a texted "Text me a link"). Opening the page never spends it; this POST does. The body
 * carries nothing: the phone, the workspace and the home or tour are re-derived from the link row. A second call, an
 * expired, revoked, unknown or wrong-kind link all answer the same.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await allowLinkRequest(req, token, "guest-signup", 20, 10))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  const resolved = await resolvePhoneBoundLink(db, token, { count: false });
  if (!resolved || resolved.link.purpose !== "account" || !isGuestSignupTarget(resolved.link.targetType)) return expiredLinkResponse();

  const result = await completeGuestSignup(db, { link: resolved.link });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });

  // Open the session the phone proof earns. Never replaces a different account's session already open in this browser.
  let signedIn = false;
  if (result.session) {
    try {
      const client = await createRealIdentitySupabaseServerClient();
      const { data: { user } } = await client.auth.getUser();
      if (!user) {
        await client.auth.setSession(result.session);
        signedIn = true;
      } else signedIn = user.id === result.userId;
    } catch {
      signedIn = false;
    }
  }
  return NextResponse.json(
    { ok: true, signedIn, nextPath: signedIn ? result.nextPath : `/auth/sign-in?next=${encodeURIComponent(result.nextPath)}` },
    { headers: NO_STORE },
  );
}
