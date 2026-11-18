import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { plaidEnabled } from "@/lib/plaid/client.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { PlaidItemRow } from "@/lib/plaid/items.server";
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
    .select("id, owner_user_id, workspace_id, purpose, item_id, access_token_enc, institution_name, account_mask, account_name, plaid_account_id, bank_account_id, transactions_cursor, status, last_error, last_synced_at")
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
    const result = await syncPlaidItem(db, row);
    tally[result.status] += 1;
  }
  return NextResponse.json(tally, { headers: { "Cache-Control": "no-store" } });
}
