import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { loadVendorVerifiedPhone, searchVendorWorkNumberCandidates } from "@/lib/vendor-work-identity.server";
import { isVendorNumberDryRun } from "@/lib/vendor-work-number-dry-run.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { signVendorWorkNumberClaim } from "@/lib/vendor-work-number-claim-token.server";

export const runtime = "nodejs";

const AREA_CODE_RE = /^[2-9]\d{2}$/;

function invalid(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

/**
 * Read-only "what could I claim" search for the vendor work-number claim flow
 * (area code -> pick one of 3 -> claim). Never purchases — `POST
 * /api/vendor/work-identity` with the chosen `phoneNumber` is the only route
 * that buys anything, and only after the same runtime/provisioning gates.
 *
 * Each offered number carries a short-lived signed `claimToken` binding it to
 * THIS vendor. The claim route requires that token and refuses any
 * `phoneNumber` presented without one — a bare `phoneNumber` in the claim
 * body is never enough to make a purchase happen (security review, VD04).
 */
export async function POST(req: Request) {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: resolved.status });

  const body = (await req.json().catch(() => null)) as { areaCode?: unknown } | null;
  const areaCode = typeof body?.areaCode === "string" ? body.areaCode.replace(/\D/g, "").slice(0, 3) : "";
  if (!AREA_CODE_RE.test(areaCode)) return invalid("Enter a valid 3-digit area code.");

  try {
    if (!(await loadVendorVerifiedPhone(createSupabaseServiceRoleClient(), resolved.userId)).verified) {
      return NextResponse.json({ ok: false, code: "phone_unverified", error: "Verify your phone to get a work number." }, { status: 403 });
    }
    const numbers = await searchVendorWorkNumberCandidates(areaCode);
    const candidates = numbers.map((phoneNumber) => ({
      phoneNumber,
      claimToken: signVendorWorkNumberClaim({ vendorUserId: resolved.userId, phoneNumber }),
    }));
    return NextResponse.json({ ok: true, candidates, ...(isVendorNumberDryRun() ? { dryRun: true } : {}) });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not search numbers right now." }, { status: 503 });
  }
}
