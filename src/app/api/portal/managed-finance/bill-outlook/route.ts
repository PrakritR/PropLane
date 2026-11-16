import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { loadBillsOutlook } from "@/lib/managed-finance/bill-pay.server";
import { financeErrorResponse } from "@/lib/managed-finance/routes.server";

export const runtime = "nodejs";

/** GET ?workspace=<id>: cash needed (awaiting approval + external bills due in 30 days) against the owner's available balance. Manager of the workspace or an admin. */
export async function GET(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth || (auth.role !== "manager" && auth.role !== "admin")) return NextResponse.json({ error: "Unauthorized." }, { status: auth ? 403 : 401 });
  const workspaceId = new URL(req.url).searchParams.get("workspace")?.trim() ?? "";
  if (!workspaceId) return NextResponse.json({ error: "Choose a workspace." }, { status: 400 });
  const { data: ws } = await auth.db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  if (!ws || (auth.role !== "admin" && String((ws as { owner_user_id?: string }).owner_user_id) !== auth.userId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  try {
    return NextResponse.json(await loadBillsOutlook(auth.db, { workspaceId }), { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    return financeErrorResponse(e, "Could not load the bills outlook.");
  }
}
