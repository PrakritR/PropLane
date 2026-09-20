import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { onlineDirectoryHits } from "@/lib/vendor-issue-search";

export const runtime = "nodejs";

/**
 * Directory lookup near the checked properties. Returns name / trade / phone /
 * city only. Nothing is saved until a box is checked in the Add vendor workspace.
 */
export async function GET(req: Request) {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const url = new URL(req.url);
  const issue = url.searchParams.get("issue")?.trim() ?? url.searchParams.get("q")?.trim() ?? "";
  const zips = url.searchParams
    .getAll("zip")
    .flatMap((value) => value.split(","))
    .map((z) => z.trim())
    .filter(Boolean);
  const rows = onlineDirectoryHits({ issue, propertyZips: zips });
  return NextResponse.json({ rows });
}
