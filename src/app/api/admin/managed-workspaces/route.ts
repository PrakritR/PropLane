import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/one-number/admin-leads-guard.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { describeManagedFee } from "@/lib/owner-management/fee-math";
import { mapPolicyRow, POLICY_COLUMNS } from "@/lib/owner-management/policies.server";

export const runtime = "nodejs";

/**
 * GET: every workspace with its newest fee policy (if any), so an admin can make one managed, send the agreement, record a signed
 * contract or end it. Admin only. A workspace with no accepted policy is not managed.
 */
export async function GET() {
  const admin = await requirePlatformAdmin();
  if ("status" in admin) return NextResponse.json({ error: admin.status === 401 ? "Unauthorized." : "Forbidden." }, { status: admin.status });
  const db = createSupabaseServiceRoleClient();
  const { data: workspaces, error } = await db.from("portal_workspaces").select("id, name, owner_user_id").order("name", { ascending: true }).limit(300);
  if (error) return NextResponse.json({ error: "Could not load workspaces." }, { status: 500 });
  const ids = ((workspaces ?? []) as Array<{ id: string }>).map((w) => String(w.id));
  const { data: policies, error: policyError } = ids.length
    ? await db.from("managed_workspace_fee_policies").select(POLICY_COLUMNS).in("workspace_id", ids).order("created_at", { ascending: false }).limit(2000)
    : { data: [], error: null };
  if (policyError && String(policyError.code) !== "42P01" && String(policyError.code) !== "PGRST205") {
    return NextResponse.json({ error: "Could not load fee policies." }, { status: 500 });
  }
  const newest = new Map<string, ReturnType<typeof mapPolicyRow>>();
  for (const raw of (policies ?? []) as Array<Record<string, unknown>>) {
    const row = mapPolicyRow(raw);
    const have = newest.get(row.workspaceId);
    // An active version outranks a draft, which outranks an ended one.
    const rank = (s: string) => (s === "active" ? 2 : s === "draft" ? 1 : 0);
    if (!have || rank(row.status) > rank(have.status)) newest.set(row.workspaceId, row);
  }
  const ownerIds = [...new Set([...newest.values()].map((p) => p.ownerUserId))];
  const { data: profiles } = ownerIds.length ? await db.from("profiles").select("id, email, full_name").in("id", ownerIds) : { data: [] };
  const nameOf = new Map(((profiles ?? []) as Array<{ id: string; email?: string; full_name?: string }>).map((p) => [String(p.id), String(p.full_name || p.email || "Owner")]));
  return NextResponse.json({
    workspaces: ((workspaces ?? []) as Array<{ id: string; name: string }>).map((w) => {
      const p = newest.get(String(w.id));
      return {
        id: String(w.id),
        name: String(w.name || "Workspace"),
        managed: p?.status === "active",
        policy: p ? { id: p.id, status: p.status, ownerUserId: p.ownerUserId, ownerName: nameOf.get(p.ownerUserId) ?? "", feeLine: describeManagedFee(p.terms), terms: p.terms, effectiveFrom: p.effectiveFrom, sentAt: p.sentAt, signedAt: p.signedAt, acceptedVia: p.acceptedVia } : null,
      };
    }),
  });
}
