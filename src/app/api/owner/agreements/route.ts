import { NextResponse } from "next/server";
import { listAgreementsForOwner } from "@/lib/owner-management/agreements.server";
import { agreementErrorResponse, presentAgreement } from "@/lib/owner-management/agreements-api.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";

export const runtime = "nodejs";

/** The signed-in owner's own agreements. The owner is the session; nothing in the request names one. */
export async function GET() {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const rows = await listAgreementsForOwner(ctx.db, ctx.userId);
    return NextResponse.json({
      agreements: rows.map((row) => ({ ...presentAgreement(row, "", null), houseLabel: row.houseLabel })),
    });
  } catch (e) {
    return agreementErrorResponse(e, "Could not load agreements.");
  }
}
