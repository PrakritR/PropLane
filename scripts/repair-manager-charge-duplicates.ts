#!/usr/bin/env npx tsx
/**
 * Remove duplicate upfront move-in charges and stale recurring rows for one manager.
 * Uses the same dedupe/stale rules as the browser charge store.
 *
 * Dev/test:
 *   npx tsx --env-file=.env scripts/repair-manager-charge-duplicates.ts --email=ambika.mago@example.com
 *
 * Dry run:
 *   npx tsx --env-file=.env scripts/repair-manager-charge-duplicates.ts --manager-id=<uuid> --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import {
  dedupeHouseholdCharges,
  duplicateHouseholdChargeIds,
  isStaleRecurringHouseholdCharge,
  type HouseholdCharge,
  type RecurringRentProfile,
} from "../src/lib/household-charges";
import { reconcileDuplicateHouseholdChargeRecords } from "../src/lib/reports/ledger-sync";

const DEFAULT_AMBIKA_MANAGER_ID = "c49d02b1-7e99-4484-9986-b3b4550c3519";

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

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let managerUserId = managerArg?.split("=")[1]?.trim() || DEFAULT_AMBIKA_MANAGER_ID;
  if (emailArg) {
    const email = emailArg.split("=")[1]?.trim().toLowerCase();
    if (!email) {
      console.error("Invalid --email value.");
      process.exit(1);
    }
    const { data, error } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
    if (error || !data?.id) {
      console.error(error?.message ?? `No profile for ${email}`);
      process.exit(1);
    }
    managerUserId = data.id;
  }

  const { data: chargeRows, error: chargeError } = await db
    .from("portal_household_charge_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId);
  if (chargeError) {
    console.error(chargeError.message);
    process.exit(1);
  }

  const charges = (chargeRows ?? [])
    .map((row) => row.row_data as HouseholdCharge | null)
    .filter((charge): charge is HouseholdCharge => Boolean(charge?.id));

  const { data: profileRows, error: profileError } = await db
    .from("portal_recurring_rent_profile_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId);
  if (profileError) {
    console.error(profileError.message);
    process.exit(1);
  }

  const profiles = (profileRows ?? [])
    .map((row) => row.row_data as RecurringRentProfile | null)
    .filter((profile): profile is RecurringRentProfile => Boolean(profile?.id));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  const staleRecurringIds = charges
    .filter(
      (charge) =>
        charge.status === "pending" &&
        isStaleRecurringHouseholdCharge(charge, profileById, charges),
    )
    .map((charge) => charge.id);

  const duplicateIds = duplicateHouseholdChargeIds(charges);
  const deduped = dedupeHouseholdCharges(charges);
  const keptIds = new Set(deduped.map((charge) => charge.id));
  const structuralRemovals = charges.filter((charge) => !keptIds.has(charge.id)).map((charge) => charge.id);

  const toDelete = [...new Set([...duplicateIds, ...staleRecurringIds, ...structuralRemovals])];

  console.log(`Manager ${managerUserId}`);
  console.log(`Charges scanned: ${charges.length}`);
  console.log(`Duplicate upfront slots: ${duplicateIds.length}`);
  console.log(`Stale recurring rows: ${staleRecurringIds.length}`);
  console.log(`Structural dedupe removals: ${structuralRemovals.length}`);
  console.log(`Total rows to delete: ${toDelete.length}`);

  if (dryRun) {
    console.log("Dry run — no rows deleted.");
    if (toDelete.length > 0) console.log(toDelete.join("\n"));
    return;
  }

  if (toDelete.length > 0) {
    const { error: deleteError } = await db
      .from("portal_household_charge_records")
      .delete()
      .eq("manager_user_id", managerUserId)
      .in("id", toDelete);
    if (deleteError) {
      console.error(deleteError.message);
      process.exit(1);
    }
  }

  const { removedChargeIds } = await reconcileDuplicateHouseholdChargeRecords(db, managerUserId);
  console.log(`Reconcile pass removed: ${removedChargeIds.length}`);
  console.log("Done. Open Residents in the portal and re-save affected residents to regenerate recurring months.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
