import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowLinkRequest, expiredLinkResponse } from "@/lib/one-number/link-http.server";
import { linkSessionCookieName, resolvePhoneBoundLink, verifyLinkSession } from "@/lib/one-number/links.server";
import { completeOnboarding } from "@/lib/resident-onboarding-link/complete.server";
import { ONBOARDING_TARGET_TYPE } from "@/lib/resident-onboarding-link/model";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Finish a text onboarding link. The request carries only the resident's own answers (name, optional email, rules,
 * group text); the record, the phone, the workspace and the house are all re-derived from the link row. It needs a
 * live code-verified session on THIS link, so no account is created, and nothing about the record is read, before
 * the phone is proven. The link is spent on success; a second call reads as an expired link.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await allowLinkRequest(req, token, "onboard", 20, 10))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  const resolved = await resolvePhoneBoundLink(db, token, { count: false });
  if (!resolved || resolved.link.purpose !== "move_in" || resolved.link.targetType !== ONBOARDING_TARGET_TYPE || !resolved.link.requiresOtp) {
    return expiredLinkResponse();
  }
  const { link } = resolved;
  const jar = await cookies();
  if (!(await verifyLinkSession(db, link, jar.get(linkSessionCookieName(token))?.value))) {
    return NextResponse.json({ error: "Enter the code we texted you first.", needsCode: true }, { status: 401, headers: NO_STORE });
  }

  const body = await req.json().catch(() => null);
  const result = await completeOnboarding(db, { link, body });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });

  // Open the portal session the phone proof earns (the same kind the code step opens for a resident's lease link).
  // Never replaces a different account's session already open in this browser.
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
    { ok: true, nextPath: signedIn ? result.nextPath : `/auth/sign-in?next=${encodeURIComponent(result.nextPath)}` },
    { headers: NO_STORE },
  );
}
