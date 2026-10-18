import { NextResponse } from "next/server";
import { loadOwnerFinances } from "@/lib/managed-finance/finances.server";
import { financeErrorResponse, requireManagedOwner } from "@/lib/managed-finance/routes.server";
import { buildManagedOwnerStatementPdf } from "@/lib/managed-finance/statement-pdf.server";

export const runtime = "nodejs";

/** GET ?workspace=<id>&month=YYYY-MM : the month's statement as a PDF. The workspace is proven by the owner-of-record lookup. */
export async function GET(req: Request) {
  const ctx = await requireManagedOwner();
  if (ctx instanceof NextResponse) return ctx;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace")?.trim() ?? "";
  if (!workspaceId) return NextResponse.json({ error: "Choose a workspace." }, { status: 400 });
  try {
    const view = await loadOwnerFinances(ctx.db, null, { ownerUserId: ctx.userId, workspaceId, month: url.searchParams.get("month") });
    const { data: profile } = await ctx.db.from("profiles").select("full_name, email").eq("id", ctx.userId).maybeSingle();
    const name = String((profile as { full_name?: string } | null)?.full_name || ctx.email || "Property owner");
    const pdf = await buildManagedOwnerStatementPdf(view, name);
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="statement-${view.month}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return financeErrorResponse(e, "Could not build your statement.");
  }
}
