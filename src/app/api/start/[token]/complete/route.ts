import { NextResponse } from "next/server";
import { allowLinkRequest, expiredLinkResponse } from "@/lib/one-number/link-http.server";
import { finishSetup } from "@/lib/one-number/onboarding/finish-setup.server";
import { resolveSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Finish setup once the phone code has signed the visitor in. The account must hold a verified phone
 * (the link's own phone, for a texted link). Creates the manager or vendor account and, for a
 * landlord, the first house as a DRAFT from what they told the agent. It never redirects: the page
 * shows an explicit "Go to your portal" button.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await allowLinkRequest(req, token, "setup-complete", 20, 10))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  const link = await resolveSetupLink(db, token);
  if (!link) return expiredLinkResponse();
  const client = await createRealIdentitySupabaseServerClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Confirm your phone first." }, { status: 401, headers: NO_STORE });
  const result = await finishSetup(db, { link, user });
  if (result.ok) {
    return NextResponse.json({ ok: true, kind: result.kind, portalHref: result.portalHref, draftCreated: result.draftPropertyId !== null, already: result.already }, { headers: NO_STORE });
  }
  if (result.reason === "waitlisted") return NextResponse.json({ ok: false, waitlisted: true }, { status: 202, headers: NO_STORE });
  if (result.reason === "phone_mismatch") return NextResponse.json({ error: "Sign in with the number this link was texted to." }, { status: 403, headers: NO_STORE });
  if (result.reason === "phone_unverified") return NextResponse.json({ error: "Confirm your phone first." }, { status: 401, headers: NO_STORE });
  return NextResponse.json({ error: "We could not finish setup right now. Try again soon." }, { status: 502, headers: NO_STORE });
}
