import { NextResponse } from "next/server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createHash } from "node:crypto";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { inferMaintenanceCategoryLabel } from "@/lib/claw-maintenance-detect";
import { searchVendorSourcingWeb } from "@/lib/vendor-sourcing-search.server";

export const runtime = "nodejs";

/**
 * Real web discovery near the checked properties. The free-text query is
 * classified locally; only that category and property ZIPs reach the provider.
 * Nothing is saved until a manager selects a candidate.
 */
export async function GET(req: Request) {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const ownerRefusal = await refuseOwnerOnly(createSupabaseServiceRoleClient(), ctx.user.id);
  if (ownerRefusal) return ownerRefusal;

  const url = new URL(req.url);
  const queryText = url.searchParams.get("issue")?.trim() ?? url.searchParams.get("q")?.trim() ?? "";
  const zips = url.searchParams
    .getAll("zip")
    .flatMap((value) => value.split(","))
    .map((z) => z.trim())
    .filter((z) => /^\d{5}(?:-\d{4})?$/.test(z));
  const zip = zips[0];
  if (!queryText || !zip) {
    return NextResponse.json({ status: "unavailable", reason: "invalid_query", rows: [], candidates: [] });
  }

  const category = inferMaintenanceCategoryLabel(queryText);
  const result = await searchVendorSourcingWeb({ category, zip });
  if (result.status === "unavailable") {
    return NextResponse.json({ status: result.status, reason: result.reason, rows: [], candidates: [] });
  }

  const candidates = result.candidates.map((candidate) => ({ ...candidate, trade: category, zip }));
  const rows = candidates.map((candidate) => ({
    id: `web:${createHash("sha256").update(candidate.url).digest("hex").slice(0, 24)}`,
    name: candidate.name,
    trade: category,
    phone: candidate.normalizedPhone ?? "",
    city: "",
  }));
  return NextResponse.json({ status: result.status, rows, candidates });
}
