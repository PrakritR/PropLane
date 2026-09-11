import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Retired: usage consumes included/prepaid credit. Never retro-bill legacy events. */
export async function invoiceManagerCommsUsage(_db: SupabaseClient, _managerUserId: string) {
  void _db; void _managerUserId;
  return { ok: true as const, invoiced: false as const, reason: "prepaid_credit" as const };
}
