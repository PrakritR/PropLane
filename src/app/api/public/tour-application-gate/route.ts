import { NextResponse } from "next/server";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { resolveApplicationBeforeTour } from "@/lib/application-before-tour.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * "Application before a tour": may the CALLER request a tour of this property yet? Answers only
 * `{ required, applicationStatus, allowed, reason }` for the caller's own session; the property owner, the setting and
 * the application are all read on the server (the query string names a property and nothing else).
 * The booking route enforces the same rule on its own — this only lets the page say so first.
 */
export async function GET(req: Request) {
  try {
    if (!(await rateLimit(`tour-application-gate:${clientIpFrom(req)}`, 60, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }
    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
    if (!propertyId) return NextResponse.json({ error: "propertyId required" }, { status: 400 });

    let verifiedEmail: string | null = null;
    try {
      const ctx = await getPortalAccessContext();
      if (ctx.user) {
        const email = (ctx.profile?.email ?? ctx.user.email ?? "").trim().toLowerCase();
        if (email.includes("@")) verifiedEmail = email;
      }
    } catch {
      /* anonymous visitor */
    }

    const decision = await resolveApplicationBeforeTour(createSupabaseServiceRoleClient(), { propertyId, verifiedEmail });
    return NextResponse.json({
      required: decision.required,
      hasApplication: decision.hasApplication,
      applicationStatus: decision.applicationStatus,
      allowed: decision.blocked === null,
      reason: decision.blocked,
      signedIn: verifiedEmail !== null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not check this home.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
