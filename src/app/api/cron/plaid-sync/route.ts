import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { plaidEnabled } from "@/lib/plaid/client.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { PLAID_ITEM_SELECT, type PlaidItemRow } from "@/lib/plaid/items.server";
import { syncPlaidItem } from "@/lib/plaid/transactions-sync.server";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Daily bank-feed catch-up. The webhook handles the live case; this covers a missed delivery. */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!plaidEnabled()) return NextResponse.json({ skipped: "disabled" }, { headers: { "Cache-Control": "no-store" } });

  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from("plaid_items")
    .select(PLAID_ITEM_SELECT)
    .eq("purpose", "bank_feed")
    .in("status", ["active", "error"])
    .not("bank_account_id", "is", null)
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(200);
  if (error) return NextResponse.json({ error: "Could not list items." }, { status: 503, headers: { "Cache-Control": "no-store" } });

  const startedAt = Date.now();
  const tally = { synced: 0, login_required: 0, error: 0, busy: 0, skipped: 0 };
  for (const row of (data ?? []) as unknown as PlaidItemRow[]) {
    if (Date.now() - startedAt > 240_000) break;
    // One item's failure is its own: the catch-up keeps walking so a single unreadable
    // row never costs every connection behind it a day of transactions.
    try {
      const result = await syncPlaidItem(db, row);
      tally[result.status] += 1;
    } catch {
      tally.error += 1;
    }
  }
  return NextResponse.json(tally, { headers: { "Cache-Control": "no-store" } });
}
