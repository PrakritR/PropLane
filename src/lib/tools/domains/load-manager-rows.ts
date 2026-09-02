import type { AgentContext } from "../context";
import { smsAccessAllowsRow, smsDataOwnerIds } from "@/lib/sms/manager-sms-access";

const PAGE_SIZE = 1000;

/**
 * Load the complete set of a landlord's records from a portal table, scoped by
 * manager_user_id and paginated by a stable column so nothing is silently
 * truncated. Ordering by the table's primary key keeps each page deterministic,
 * which is what makes the range loop complete (no skipped or duplicated rows)
 * regardless of how many records the landlord has.
 *
 * On a manager-SMS turn with `ctx.managerSmsAccess`, extra co-managed owners
 * are included and rows are filtered to assigned properties. Portal turns
 * (no access field) keep the original landlord-only query.
 */
export async function loadAllManagerRows<T>(
  ctx: Pick<AgentContext, "db" | "landlordId" | "managerSmsAccess">,
  table: string,
  map: (rowData: unknown) => T,
): Promise<T[]> {
  const out: T[] = [];
  const ownerIds = smsDataOwnerIds(ctx);
  for (const ownerId of ownerIds) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await ctx.db
        .from(table)
        .select("row_data, manager_user_id")
        .eq("manager_user_id", ownerId)
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { row_data: unknown; manager_user_id?: string | null }[];
      for (const r of rows) {
        if (
          !smsAccessAllowsRow(ctx.managerSmsAccess, {
            dataOwnerId: String(r.manager_user_id ?? ownerId).trim() || ownerId,
            rowData: r.row_data,
            table,
          })
        ) {
          continue;
        }
        out.push(map(r.row_data));
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return out;
}
