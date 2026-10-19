import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOwnerFinances } from "@/lib/managed-finance/finances.server";
import { listManagedWorkspacesForOwner } from "@/lib/owner-management/policies.server";
import { grantedHouses, type OwnerGrant } from "@/lib/property-owner/access.server";
import type { OwnerAttentionItem, OwnerOverviewExtras, OwnerUpcomingItem } from "@/lib/property-owner/projection";

const MISSING_SCHEMA = new Set(["42P01", "42703", "PGRST205"]);
const UPCOMING_DAYS = 30;
const STATEMENT_FRESH_DAYS = 14;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The Overview's extras: what PropLane-held funds add to the numbers (fee, net, available), what needs the owner (repair
 * approvals, a statement that just landed, an agreement to sign) and what is coming up (the dates rooms change hands).
 *
 * Everything is scoped by the owner's own `grants` (already narrowed to the workspace the switcher chose) and by their own
 * user id as owner of record; a request never names a workspace outside them. No resident, vendor or ledger-line field
 * leaves here: a repair is a title and an amount, an upcoming date is a house, a room and a day.
 */
export async function loadOwnerOverviewExtras(
  db: SupabaseClient,
  ownerUserId: string,
  grants: OwnerGrant[],
  now: Date = new Date(),
): Promise<OwnerOverviewExtras> {
  const scopeIds = new Set(grants.map((g) => g.workspaceId).filter(Boolean));

  let managedWorkspaces: Awaited<ReturnType<typeof listManagedWorkspacesForOwner>> = [];
  try {
    managedWorkspaces = (await listManagedWorkspacesForOwner(db, ownerUserId)).filter((w) => scopeIds.has(w.workspaceId));
  } catch {
    managedWorkspaces = [];
  }

  const attention: OwnerAttentionItem[] = [];
  let firstManagedId: string | null = null;
  let managedTotals: { rentCents: number; feeCents: number; netCents: number; availableCents: number } | null = null;
  for (const workspace of managedWorkspaces) {
    try {
      const view = await loadOwnerFinances(db, null, { ownerUserId, workspaceId: workspace.workspaceId }, now);
      const sums: { rentCents: number; feeCents: number; netCents: number; availableCents: number } = managedTotals ?? { rentCents: 0, feeCents: 0, netCents: 0, availableCents: 0 };
      managedTotals = {
        rentCents: sums.rentCents + view.statement.totals.rentGrossCents,
        feeCents: sums.feeCents + view.statement.totals.feeCents,
        netCents: sums.netCents + view.statement.totals.netCents,
        availableCents: sums.availableCents + view.balance.availableCents,
      };
      firstManagedId ??= workspace.workspaceId;
      for (const approval of view.pendingApprovals) {
        attention.push({ kind: "repair", id: approval.id, title: approval.title, amountCents: approval.amountCents, workspaceId: workspace.workspaceId });
      }
    } catch {
      // One workspace that cannot be read leaves its figures out; it never blanks the others.
    }
  }

  // A statement that landed in the last two weeks (the 1st-of-month send), and any agreement waiting for a signature.
  const inScope = [...scopeIds];
  if (inScope.length > 0) {
    const since = new Date(now.getTime() - STATEMENT_FRESH_DAYS * 86_400_000).toISOString();
    const { data: statements, error: statementError } = await db
      .from("owner_statements")
      .select("id, workspace_id, month_key, created_at")
      .in("workspace_id", inScope)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    if (!statementError || !MISSING_SCHEMA.has(String((statementError as { code?: string }).code ?? ""))) {
      for (const row of (statements ?? []) as { id: unknown; workspace_id: unknown; month_key: unknown }[]) {
        attention.push({ kind: "statement", id: String(row.id), month: String(row.month_key ?? ""), workspaceId: String(row.workspace_id) });
      }
    }
    const { data: drafts, error: draftError } = await db
      .from("managed_workspace_fee_policies")
      .select("id, workspace_id")
      .eq("owner_user_id", ownerUserId)
      .eq("status", "draft")
      .not("sent_at", "is", null)
      .in("workspace_id", inScope)
      .limit(10);
    if (!draftError || !MISSING_SCHEMA.has(String((draftError as { code?: string }).code ?? ""))) {
      for (const row of (drafts ?? []) as { id: unknown; workspace_id: unknown }[]) {
        attention.push({ kind: "agreement", id: String(row.id), workspaceId: String(row.workspace_id) });
      }
    }
  }

  // Upcoming: the move-in and move-out dates of rooms in the owner's performance-granted houses.
  const upcoming: OwnerUpcomingItem[] = [];
  const houses = grantedHouses(grants, "performance");
  if (houses.length > 0) {
    const { data, error } = await db
      .from("resident_inspections")
      .select("id, property_id, property_label, room_label, kind, inspection_date")
      .in("property_id", houses.map((h) => h.propertyId))
      .gte("inspection_date", isoDay(now.getTime()))
      .lte("inspection_date", isoDay(now.getTime() + UPCOMING_DAYS * 86_400_000))
      .order("inspection_date", { ascending: true })
      .limit(10);
    if (!error) {
      for (const row of (data ?? []) as { id: unknown; property_label: unknown; room_label: unknown; kind: unknown; inspection_date: unknown }[]) {
        const kind = row.kind === "move-out" ? "move-out" : "move-in";
        upcoming.push({
          id: String(row.id),
          kind,
          date: String(row.inspection_date ?? "").slice(0, 10),
          house: String(row.property_label ?? "").trim(),
          unit: String(row.room_label ?? "").trim(),
        });
      }
    }
  }

  const managed: OwnerOverviewExtras["managed"] = managedTotals && firstManagedId ? { workspaceId: firstManagedId, ...managedTotals } : null;
  return { managed, attention, upcoming };
}
