import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChainVendor } from "@/lib/vendor-dispatch/types";

/**
 * Hook for the PropLane Service-wide vendor roster (on/adminops). A service workspace's dispatch chain is its own roster first,
 * then whatever vendors the service team keeps for the trade across every service workspace. Until that roster exists this
 * returns nothing, so dispatch behaves exactly as before; the adminops lane replaces the body, never the call sites.
 */
export type ServiceRosterVendor = Omit<ChainVendor, "position">;

export async function serviceRosterVendorsForTrade(
  db: SupabaseClient,
  input: { workspaceId: string; trade: string },
): Promise<ServiceRosterVendor[]> {
  void db;
  void input;
  return [];
}
