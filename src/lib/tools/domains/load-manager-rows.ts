import type { AgentContext } from "../context";
import { smsAccessAllowsRow, smsDataOwnerIds } from "@/lib/sms/manager-sms-access";
import type { CoManagerPermissionId } from "@/lib/co-manager-permissions";
import { rowAllowedInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import { turnCached } from "../turn-cache";

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
  ctx: Pick<AgentContext, "db" | "landlordId" | "managerSmsAccess" | "workspace">,
  table: string,
  map: (rowData: unknown) => T,
  module?: CoManagerPermissionId,
): Promise<T[]> {
  const ownerIds = smsDataOwnerIds(ctx);
  // Owners are independent reads: fetched together, kept in owner order.
  const perOwner = await Promise.all(ownerIds.map((ownerId) => fetchOwnerRows(ctx, table, ownerId)));
  const out: T[] = [];
  ownerIds.forEach((ownerId, index) => {
    for (const r of perOwner[index]!) {
      if (
        !smsAccessAllowsRow(ctx.managerSmsAccess, {
          dataOwnerId: String(r.manager_user_id ?? ownerId).trim() || ownerId,
          rowData: r.row_data,
          table,
          module,
        })
      ) {
        continue;
      }
      if (!rowAllowedInAgentWorkspace(ctx, r.row_data)) continue;
      out.push(map(r.row_data));
    }
  });
  return out;
}

type RawRow = { row_data: unknown; manager_user_id?: string | null };

/**
 * Tables a turn reads again and again (a resident question touches applications, leases and charges from several
 * tools). Within ONE turn context the raw rows are fetched once; the next turn builds a new context and reads fresh.
 * Only tables no inline write tool mutates are listed.
 */
const TURN_CACHED_TABLES = new Set([
  "manager_application_records",
  "portal_lease_pipeline_records",
  "portal_household_charge_records",
  "portal_work_order_records",
  "portal_service_request_records",
  "manager_vendor_records",
]);

function fetchOwnerRows(ctx: Pick<AgentContext, "db">, table: string, ownerId: string): Promise<RawRow[]> {
  if (!TURN_CACHED_TABLES.has(table)) return readOwnerRows(ctx, table, ownerId);
  return turnCached(ctx, `rows\0${table}\0${ownerId}`, () => readOwnerRows(ctx, table, ownerId));
}

async function readOwnerRows(ctx: Pick<AgentContext, "db">, table: string, ownerId: string): Promise<RawRow[]> {
  const rows: RawRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await ctx.db
      .from(table)
      .select("row_data, manager_user_id")
      .eq("manager_user_id", ownerId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as RawRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}
