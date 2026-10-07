import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import {
  getVendorWorkIdentity,
  loadVendorVerifiedPhone,
  setVendorForwardToPhone,
  setupVendorWorkIdentity,
} from "@/lib/vendor-work-identity.server";
import { isUsLocalSmsNumber, verifyVendorWorkNumberClaim } from "@/lib/vendor-work-number-claim-token.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function invalid(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

async function actor() {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) return { response: NextResponse.json({ ok: false, error: "Unauthorized." }, { status: resolved.status }) };
  return { userId: resolved.userId };
}

export async function GET() {
  const current = await actor();
  if ("response" in current) return current.response;
  try {
    return NextResponse.json({ ok: true, identity: await getVendorWorkIdentity(createSupabaseServiceRoleClient(), current.userId) });
  } catch {
    return NextResponse.json({ ok: false, error: "Work identity is temporarily unavailable." }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const current = await actor();
  if ("response" in current) return current.response;
  const body = await req.json().catch(() => null) as { channel?: unknown; idempotencyKey?: unknown; phoneNumber?: unknown; claimToken?: unknown } | null;
  const channel = typeof body?.channel === "string" ? body.channel : "";
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (channel !== "email" && channel !== "sms") return invalid("channel must be email or sms.");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(idempotencyKey)) return invalid("A UUID idempotencyKey is required.");
  // A bare phoneNumber is never authority to purchase it — every SMS claim
  // must carry the signed claimToken minted by /candidates for THIS exact
  // number and THIS exact vendor, or nothing is purchased (security review,
  // VD04: a client could otherwise make PropLane buy any Twilio number —
  // toll-free, premium-rate, foreign — just by naming it in the body).
  let selectedPhoneNumber: string | undefined;
  if (channel === "sms") {
    // Eligibility is a verified phone, nothing else (Oct 6): no card, no plan.
    if (!(await loadVendorVerifiedPhone(createSupabaseServiceRoleClient(), current.userId)).verified) {
      return NextResponse.json({ ok: false, code: "phone_unverified", error: "Verify your phone to get a work number." }, { status: 403 });
    }
    const phoneNumber = typeof body?.phoneNumber === "string" ? body.phoneNumber.trim() : "";
    const claimToken = typeof body?.claimToken === "string" ? body.claimToken.trim() : "";
    if (!phoneNumber || !claimToken) return invalid("phoneNumber and claimToken are both required to claim a work number.");
    const claim = verifyVendorWorkNumberClaim(claimToken);
    if (!claim) return invalid("This claim has expired or is invalid — search numbers again.");
    if (claim.vendorUserId !== current.userId) return invalid("This claim does not belong to your account.");
    if (claim.phoneNumber !== phoneNumber) return invalid("phoneNumber does not match the claim.");
    if (!isUsLocalSmsNumber(phoneNumber)) return invalid("Only a US local number can be claimed.");
    selectedPhoneNumber = phoneNumber;
  }
  try {
    // The lifecycle currently reconciles the requested channel through the
    // provider adapter; its runtime gates prevent a dev request from buying a
    // number or sending mail when provider configuration is absent.
    const identity = await setupVendorWorkIdentity(
      createSupabaseServiceRoleClient(),
      current.userId,
      idempotencyKey,
      channel,
      undefined,
      selectedPhoneNumber,
    );
    return NextResponse.json({ ok: true, identity });
  } catch {
    return NextResponse.json({ ok: false, error: "Work identity setup could not be started." }, { status: 503 });
  }
}

/** Turn forwarding of managers' texts to the vendor's verified phone on or off. */
export async function PATCH(req: Request) {
  const current = await actor();
  if ("response" in current) return current.response;
  const body = await req.json().catch(() => null) as { forwardToPhone?: unknown } | null;
  if (typeof body?.forwardToPhone !== "boolean") return invalid("forwardToPhone must be true or false.");
  try {
    const db = createSupabaseServiceRoleClient();
    if (!(await setVendorForwardToPhone(db, current.userId, body.forwardToPhone))) {
      return NextResponse.json({ ok: false, error: "Claim a work number before changing forwarding." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, identity: await getVendorWorkIdentity(db, current.userId) });
  } catch {
    return NextResponse.json({ ok: false, error: "Forwarding could not be saved right now." }, { status: 503 });
  }
}
