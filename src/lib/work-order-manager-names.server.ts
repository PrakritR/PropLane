import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

/**
 * Stamp each work order with the NAME of the manager who owns it.
 *
 * The row carries `managerUserId` but never a name, so the vendor's Payments
 * screen rendered its fallback — "Property manager" — on every row. A vendor
 * working for two managers could not tell whose invoice was whose, which is the
 * whole purpose of that screen (PRP-252).
 *
 * One `profiles` read for the whole page: a per-row join would be N queries on
 * a list, and egress is a stated constraint.
 *
 * A manager with no `full_name` is left alone rather than stamped with an empty
 * string, so the client's fallback still applies to exactly the rows that have
 * no better answer.
 */
export async function attachManagerNamesToWorkOrders(
  db: SupabaseClient,
  rows: DemoManagerWorkOrderRow[],
): Promise<DemoManagerWorkOrderRow[]> {
  const managerIds = [...new Set(rows.map((row) => row.managerUserId?.trim()).filter(Boolean))] as string[];
  if (managerIds.length === 0) return rows;

  const { data: profiles } = await db.from("profiles").select("id, full_name").in("id", managerIds);
  const nameById = new Map<string, string>();
  for (const profile of profiles ?? []) {
    const id = String(profile.id ?? "").trim();
    const name = typeof profile.full_name === "string" ? profile.full_name.trim() : "";
    if (id && name) nameById.set(id, name);
  }

  return rows.map((row) => {
    const managerId = row.managerUserId?.trim();
    if (!managerId) return row;
    const managerName = nameById.get(managerId);
    return managerName ? { ...row, managerName } : row;
  });
}
