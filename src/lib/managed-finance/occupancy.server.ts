import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { queryOccupancyReport } from "@/lib/reports/formal-documents/scoped-queries";
import { monthEnd, monthStart } from "@/lib/property-owner/projection";
import { pacificMonthKey } from "@/lib/owner-management/fee-math";

/** Rooms occupied / total across a managed workspace's houses, for the month. Counts only; no resident is read. */
export async function workspaceOccupancy(
  db: SupabaseClient,
  workspaceId: string,
  month: string = pacificMonthKey(new Date()),
): Promise<{ houses: number; units: number; occupied: number } | null> {
  try {
    const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
    const manager = String((ws as { owner_user_id?: string } | null)?.owner_user_id ?? "");
    if (!manager) return null;
    const { data: props } = await db.from("manager_property_records").select("id").eq("workspace_id", workspaceId).limit(500);
    const ids = ((props ?? []) as Array<{ id: string }>).map((p) => String(p.id));
    if (ids.length === 0) return { houses: 0, units: 0, occupied: 0 };
    const report = await queryOccupancyReport(db, manager, { scope: "portfolio", from: monthStart(month), to: monthEnd(month), workspacePropertyIds: ids });
    return {
      houses: report.properties.length,
      units: report.properties.reduce((s, p) => s + p.totalUnits, 0),
      occupied: report.properties.reduce((s, p) => s + p.occupiedUnits, 0),
    };
  } catch {
    return null;
  }
}
