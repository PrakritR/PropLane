import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { grantedHouses } from "@/lib/property-owner/access.server";
import { monthEnd, monthStart, parseOwnerPeriod } from "@/lib/property-owner/projection";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";
import { buildOwnerStatementPdf, type OwnerStatementLine } from "@/lib/reports/export/formal/owner-statement-pdf";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { queryOwnerStatement } from "@/lib/reports/queries/ap-reports";

export const runtime = "nodejs";

async function loadAgentIdentity(db: SupabaseClient, managerUserId: string) {
  const { data } = await db
    .from("manager_tax_profiles")
    .select("legal_name, address_line1, address_line2, city, state, zip")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const name = data?.legal_name?.trim() || "Property manager";
  const address =
    [
      data?.address_line1?.trim(),
      data?.address_line2?.trim(),
      [data?.city, data?.state, data?.zip].filter(Boolean).join(", ").trim(),
    ]
      .filter(Boolean)
      .join("\n") || "—";
  return { name, address };
}

/**
 * GET /api/owner/statements/pdf?month=YYYY-MM[&propertyId=]
 *
 * The owner's statement for one month. The manager's formal export reads
 * `auth.userId` directly and so cannot serve an owner; this route resolves the
 * manager and the houses from the owner membership and runs the same
 * `queryOwnerStatement` + PDF builder, narrowed to the houses granted for
 * statements. The PDF omits the unpaid-bills (AP) line: that is a vendor-side
 * figure, not part of an owner's statement.
 */
export async function GET(req: Request) {
  const ctx = await requireOwnerRoute();
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const month = parseOwnerPeriod(url.searchParams.get("month"));
  if (!month) return NextResponse.json({ error: "Choose a month like 2026-10." }, { status: 400 });

  let houses = grantedHouses(ctx.grants, "statements");
  const requested = (url.searchParams.get("propertyId") ?? "").trim();
  if (requested) houses = houses.filter((h) => h.propertyId === requested);
  if (houses.length === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // One PDF per manager; an owner with houses under two managers asks per house.
  const managerUserId = houses[0]!.managerUserId;
  const propertyIds = houses.filter((h) => h.managerUserId === managerUserId).map((h) => h.propertyId);
  try {
    const report = await queryOwnerStatement(ctx.db, managerUserId, {
      from: monthStart(month),
      to: monthEnd(month),
      workspacePropertyIds: propertyIds,
    });
    const [agent, display] = await Promise.all([
      loadAgentIdentity(ctx.db, managerUserId),
      loadManagerReportDisplayContext(ctx.db, managerUserId),
    ]);
    const amountByLine = new Map(report.rows.map((r) => [String(r.line), String(r.amount)]));
    const lines: OwnerStatementLine[] = [
      { label: "Cash in (collections)", amount: amountByLine.get("Cash in (collections)") ?? "$0.00" },
      { label: "Cash out (expenses paid)", amount: amountByLine.get("Cash out (expenses paid)") ?? "$0.00" },
      { label: "Management fee", amount: amountByLine.get("Management fee") ?? "$0.00" },
      { label: "Reserve holdback", amount: amountByLine.get("Reserve holdback") ?? "$0.00" },
    ];
    const pdf = await buildOwnerStatementPdf({
      issueDate: new Date().toISOString().slice(0, 10),
      periodFrom: monthStart(month),
      periodTo: monthEnd(month),
      landlordName: agent.name,
      landlordAddress: agent.address,
      ownerName: "Property owner",
      propertyLabel: propertyIds.length === 1 ? display.propertyLabel(propertyIds[0]!) : `${propertyIds.length} houses`,
      lines,
      distribution: String(report.meta?.distribution ?? amountByLine.get("Distribution") ?? "$0.00"),
    });
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="statement-${month}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not build your statement." }, { status: 500 });
  }
}
