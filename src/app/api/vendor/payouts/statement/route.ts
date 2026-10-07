import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { stripePayoutErrorResponse } from "@/lib/stripe-payouts.server";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { buildVendorStatement, vendorStatementCsv } from "@/lib/vendor-banking/statement.server";

export const runtime = "nodejs";

/** The vendor's own full ledger statement — every ledger line with its event type and running balance, opening/closing balance, the months with activity, optional month filter, CSV export. */
export async function GET(req: Request) {
  try {
    if (!vendorBankingEnabled()) {
      return NextResponse.json({ error: "Vendor banking is not enabled." }, { status: 404 });
    }
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }
    const url = new URL(req.url);
    const month = url.searchParams.get("month");
    const format = url.searchParams.get("format");

    const db = createSupabaseServiceRoleClient();
    const statement = await buildVendorStatement(db, access.actor.userId, { month });

    if (format === "csv") {
      return new NextResponse(vendorStatementCsv(statement), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="statement${month ? `-${month}` : ""}.csv"`,
        },
      });
    }
    if (url.searchParams.get("summary") === "1") {
      // The Statements list needs the months and the reconciliation stamp, never every line.
      const { months, reconciliation, openingCents, closingCents } = statement;
      return NextResponse.json({ months, reconciliation, openingCents, closingCents });
    }
    return NextResponse.json(statement);
  } catch (e) {
    return stripePayoutErrorResponse("vendor/payouts/statement GET", e);
  }
}
