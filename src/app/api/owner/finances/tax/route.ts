import { NextResponse } from "next/server";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { loadOwnerTaxPackage } from "@/lib/managed-finance/tax-package.server";
import { pacificMonthKey } from "@/lib/owner-management/fee-math";

export const runtime = "nodejs";

/** GET ?workspace=<id>&year=YYYY[&format=csv]: the owner's year-end package (Schedule E-ready totals, vendors for 1099s). */
export async function GET(req: Request) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace")?.trim() ?? "";
  if (!workspaceId) return NextResponse.json({ error: "Choose a workspace." }, { status: 400 });
  const year = Number(url.searchParams.get("year") || pacificMonthKey(new Date()).slice(0, 4));
  try {
    const view = await loadOwnerTaxPackage(ctx.db, { ownerUserId: ctx.userId, workspaceId, year });
    if (url.searchParams.get("format") === "csv") {
      return new NextResponse(view.csv, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="tax-package-${year}.csv"`, "Cache-Control": "private, no-store" },
      });
    }
    return NextResponse.json({ package: view.package, houseLabels: view.houseLabels });
  } catch (e) {
    return financeErrorResponse(e, "Could not build your tax package.");
  }
}
