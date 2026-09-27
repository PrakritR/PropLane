import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { searchVendorWorkNumberCandidates } from "@/lib/vendor-work-identity.server";

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
 */
export async function POST(req: Request) {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: resolved.status });

  const body = (await req.json().catch(() => null)) as { areaCode?: unknown } | null;
  const areaCode = typeof body?.areaCode === "string" ? body.areaCode.replace(/\D/g, "").slice(0, 3) : "";
  if (!AREA_CODE_RE.test(areaCode)) return invalid("Enter a valid 3-digit area code.");

  try {
    const candidates = await searchVendorWorkNumberCandidates(areaCode);
    return NextResponse.json({ ok: true, candidates });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not search numbers right now." }, { status: 503 });
  }
}
