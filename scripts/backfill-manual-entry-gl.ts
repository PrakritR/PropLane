#!/usr/bin/env npx tsx
/**
 * Post General Ledger journals for manual income / expense entries that never reached the GL
 * (the "No entries yet" General Ledger report next to a Finances overview that shows the money).
 *
 * Idempotent: every journal is keyed by its entry id, so a re-run posts nothing new. DRY RUN by default;
 * nothing is written until --apply.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/backfill-manual-entry-gl.ts
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/backfill-manual-entry-gl.ts --apply --manager=<uuid>
 *
 * Production needs --allow-production AND --manager (never a whole-database sweep), and the production
 * environment file; the owner's explicit authorization comes first (AGENTS.md hard stops).
 */
import { createClient } from "@supabase/supabase-js";
import { repairManualEntryGl } from "../src/lib/reports/gl-posting";

const PRODUCTION_REF = "qahnczmilgptcedaqype";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const managerArg = process.argv.find((a) => a.startsWith("--manager="));
  const managerUserId = managerArg?.split("=")[1]?.trim() || undefined;
  if (url.includes(PRODUCTION_REF) && !(process.argv.includes("--allow-production") && managerUserId)) {
    console.error("This is the live project: pass --allow-production and --manager=<uuid> (and have the owner's authorization).");
    process.exit(1);
  }
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const result = await repairManualEntryGl(db, { managerUserId, dryRun: !apply });
  console.log(JSON.stringify({ target: url.replace(/^https:\/\//, "").split(".")[0], managerUserId: managerUserId ?? "all", ...result }, null, 2));
  if (result.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
