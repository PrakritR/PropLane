#!/usr/bin/env npx tsx
/**
 * Manual/on-demand run of the PropLane balance reconciliation backstop —
 * finds succeeded `platform_ledger` Stripe PaymentIntents with no matching
 * `proplane_balance_entries` row (the best-effort webhook credit in
 * `household-charge-credit.server.ts` failed) and credits them idempotently.
 * See `src/lib/proplane-balance/reconcile.server.ts` for the full contract.
 * The same reconciliation also runs on a schedule via
 * `/api/cron/reconcile-proplane-balance` (see `vercel.json`).
 *
 * A no-op entirely unless `PROPLANE_BALANCE_ENABLED` is set in the loaded env.
 *
 * Dev/test:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/reconcile-proplane-balance.ts
 *
 * Options:
 *   --limit=50              cap on PaymentIntents scanned (default 200)
 *   --since-days=14         look back this many days instead of the default 7
 *
 * Production (captain runs manually — never from an agent):
 *   npx tsx --env-file=.env.production.local --conditions=react-server scripts/reconcile-proplane-balance.ts
 */
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { reconcilePlatformLedgerCharges } from "../src/lib/proplane-balance/reconcile.server";

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();

  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!stripeKey) {
    console.error("Missing STRIPE_SECRET_KEY.");
    process.exit(1);
  }
  if (stripeKey.startsWith("sk_live_")) {
    console.error("Refusing: STRIPE_SECRET_KEY is a LIVE key. This script is dev/test-mode only.");
    process.exit(1);
  }

  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const sinceDaysArg = process.argv.find((a) => a.startsWith("--since-days="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  const sinceDays = sinceDaysArg ? Number(sinceDaysArg.split("=")[1]) : undefined;

  const db = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const stripe = new Stripe(stripeKey, { apiVersion: "2026-03-25.dahlia", typescript: true });

  const result = await reconcilePlatformLedgerCharges(stripe, db, {
    limit,
    createdAfterEpochSeconds: sinceDays ? Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60 : undefined,
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
