import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { allowLinkRequest, expiredLinkResponse } from "@/lib/one-number/link-http.server";
import { propertyBelongsToWorkspace, residentPhoneMatches } from "@/lib/one-number/link-destinations.server";
import { linkSessionCookieName, resolvePhoneBoundLink, verifyLinkSession } from "@/lib/one-number/links.server";
import { residentAchStatusResponse, residentAchVerifyResponse } from "@/lib/resident-ach-payment.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The bank-payment status read (GET) and microdeposit verification (POST) behind the "Pay from bank" option on a rent
 * link. The caller proves the phone the same way `rent-checkout` does (a live verified session on THIS link), and the
 * actor is the resident the link's live charges name; the shared core then checks that the bank attempt belongs to that
 * exact resident before it reads or verifies anything. Nothing about who pays comes from the request.
 */
async function linkedResident(req: Request, token: string): Promise<{ userId: string } | Response> {
  if (!(await allowLinkRequest(req, token, "rent-bank", 60, 10))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  const resolved = await resolvePhoneBoundLink(db, token, { count: false });
  if (!resolved || resolved.link.purpose !== "rent") return expiredLinkResponse();
  const { link } = resolved;
  const jar = await cookies();
  const verified = await verifyLinkSession(db, link, jar.get(linkSessionCookieName(token))?.value);
  if (!verified) return NextResponse.json({ error: "Enter the code we texted you first.", needsCode: true }, { status: 401, headers: NO_STORE });
  // The payer is the resident the link's own charge names, proven again against this phone and this link's workspace.
  // This is read straight from the charge (not through the rent view) so a bank payment that is now clearing, which the
  // rent view reads as "paid", can still be followed to its end.
  const chargeId = link.targetId.split(",")[0]?.trim() ?? "";
  const { data: row } = chargeId ? await db.from("portal_household_charge_records").select("row_data").eq("id", chargeId).maybeSingle() : { data: null };
  const charge = ((row as { row_data?: Record<string, unknown> } | null)?.row_data ?? null) as { propertyId?: string; residentUserId?: string } | null;
  const userId = String(charge?.residentUserId ?? "").trim();
  if (!charge || !userId || !(await propertyBelongsToWorkspace(db, String(charge.propertyId ?? ""), link.workspaceId)) || !(await residentPhoneMatches(db, userId, link.phoneKey))) {
    return expiredLinkResponse();
  }
  return { userId };
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const actor = await linkedResident(req, token);
  if (actor instanceof Response) return actor;
  const id = new URL(req.url).searchParams.get("payment_intent_id")?.trim();
  return residentAchStatusResponse(id, actor.userId);
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const actor = await linkedResident(req, token);
  if (actor instanceof Response) return actor;
  return residentAchVerifyResponse(req, actor.userId);
}
