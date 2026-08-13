#!/usr/bin/env npx tsx
/**
 * Remove duplicate upfront move-in charge rows for one manager (server-side dedupe only).
 *
 * Dev/test:
 *   npx tsx --env-file=.env scripts/repair-manager-charge-duplicates.ts --email=manager@test.proplane.local
 *
 * Dry run:
 *   npx tsx --env-file=.env scripts/repair-manager-charge-duplicates.ts --manager-id=<uuid> --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import { reconcileDuplicateHouseholdChargeRecords } from "../src/lib/reports/ledger-sync";

function projectRefFromUrl(url: string): string | null {
  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return match?.[1] ?? null;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const emailArg = process.argv.find((a) => a.startsWith("--email="));
  const managerArg = process.argv.find((a) => a.startsWith("--manager-id="));
  const allowTarget = process.env.ALLOW_PROBE_TARGET?.trim();

  const projectRef = projectRefFromUrl(url);
  if (!allowTarget || !projectRef || allowTarget !== projectRef) {
    console.error(
      `Refusing to run: set ALLOW_PROBE_TARGET=${projectRef ?? "<project-ref>"} to confirm the Supabase project.`,
    );
    process.exit(1);
  }

  let managerUserId = managerArg?.split("=")[1]?.trim();
  if (emailArg) {
    const email = emailArg.split("=")[1]?.trim().toLowerCase();
    if (!email) {
      console.error("Invalid --email value.");
      process.exit(1);
    }
    const db = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
    if (error || !data?.id) {
      console.error(error?.message ?? `No profile for ${email}`);
      process.exit(1);
    }
    managerUserId = data.id;
  }

  if (!managerUserId) {
    console.error("Pass --manager-id=<uuid> or --email=<address>.");
    process.exit(1);
  }

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (dryRun) {
    const { data: chargeRows } = await db
      .from("portal_household_charge_records")
      .select("id")
      .eq("manager_user_id", managerUserId);
    console.log(`Manager ${managerUserId}: ${chargeRows?.length ?? 0} charge rows (dry run — no deletes).`);
    return;
  }

  const { removedChargeIds } = await reconcileDuplicateHouseholdChargeRecords(db, managerUserId);
  console.log(`Manager ${managerUserId}`);
  console.log(`Duplicate rows removed: ${removedChargeIds.length}`);
  if (removedChargeIds.length > 0) console.log(removedChargeIds.join("\n"));
  console.log("Done. Re-save affected residents in the portal to refresh recurring months.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
