import { NextResponse } from "next/server";
import { allowLinkRequest, expiredLinkResponse } from "@/lib/one-number/link-http.server";
import { resolvePhoneBoundLink } from "@/lib/one-number/links.server";
import { completePersonalAccount } from "@/lib/personal-link/complete.server";
import { PERSONAL_LINK_TARGET_TYPE } from "@/lib/personal-link/model";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Finish a personal account link. The request carries only the person's own answers (name, optional email); the
 * phone, the workspace and the home are all re-derived from the link row. The link is spent on success, so a second
 * call reads as an expired link, and every dead, wrong-purpose or unknown token answers the same.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await allowLinkRequest(req, token, "account", 20, 10))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  const resolved = await resolvePhoneBoundLink(db, token, { count: false });
  if (!resolved || resolved.link.purpose !== "account" || resolved.link.targetType !== PERSONAL_LINK_TARGET_TYPE) {
    return expiredLinkResponse();
  }

  const body = await req.json().catch(() => null);
  const result = await completePersonalAccount(db, { link: resolved.link, body });
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
    {
      ok: true,
      signedIn,
      nextPath: signedIn ? result.nextPath : `/auth/sign-in?next=${encodeURIComponent(result.nextPath)}`,
      propertyPath: signedIn ? result.propertyPath : null,
    },
    { headers: NO_STORE },
  );
}
