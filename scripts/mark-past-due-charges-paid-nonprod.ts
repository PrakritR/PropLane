#!/usr/bin/env npx tsx
/**
 * PRP-408 part 3 — Mark past-due unpaid household charges as paid on
 * **dev/test or staging only**. Never production.
 *
 * Dry-run (default):
 *   ALLOW_PROBE_TARGET=emstjswhotsnyksqhqyf \
 *     npx tsx --env-file=.env scripts/mark-past-due-charges-paid-nonprod.ts \
 *     --email=manager@test.proplane.local
 *
 * Apply:
 *   ALLOW_PROBE_TARGET=emstjswhotsnyksqhqyf \
 *     npx tsx --env-file=.env scripts/mark-past-due-charges-paid-nonprod.ts \
 *     --email=manager@test.proplane.local --apply
 *
 * Ambika production cleanup is REFUSED here — use the portal after promote, or a
 * named captain waiver script if one is filed later.
 */

import { createClient } from "@supabase/supabase-js";
import { NONPRODUCTION_PROJECTS } from "./security/nonproduction-database.mjs";
import {
  isHouseholdChargeOverdue,
  type HouseholdCharge,
} from "../src/lib/household-charges";

function projectRefFromUrl(url: string): string | null {
  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return match?.[1] ?? null;
}

function parseArgs(argv: string[]) {
  const out: { apply: boolean; email?: string; managerId?: string; help?: boolean } = {
    apply: false,
  };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--email=")) out.email = a.slice("--email=".length).trim().toLowerCase();
    else if (a.startsWith("--manager-id=")) out.managerId = a.slice("--manager-id=".length).trim();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  ALLOW_PROBE_TARGET=<dev-or-staging-ref> \\
    npx tsx --env-file=.env scripts/mark-past-due-charges-paid-nonprod.ts \\
    --email=<manager> | --manager-id=<uuid> [--apply]`);
    process.exit(0);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const projectRef = projectRefFromUrl(url);
  const allowTarget = process.env.ALLOW_PROBE_TARGET?.trim();
  if (!projectRef || !NONPRODUCTION_PROJECTS.includes(projectRef)) {
    console.error(
      `Refusing: project ${projectRef ?? "(unknown)"} is not a non-production PropLane DB.`,
    );
    process.exit(1);
  }
  if (!allowTarget || allowTarget !== projectRef) {
    console.error(
      `Refusing: set ALLOW_PROBE_TARGET=${projectRef} to confirm the Supabase project.`,
    );
    process.exit(1);
  }

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let managerUserId = args.managerId;
  if (args.email) {
    const { data, error } = await db.from("profiles").select("id").eq("email", args.email).maybeSingle();
    if (error || !data?.id) {
      console.error(error?.message ?? `No profile for ${args.email}`);
      process.exit(1);
    }
    managerUserId = data.id;
  }
  if (!managerUserId) {
    console.error("Pass --manager-id=<uuid> or --email=<address>.");
    process.exit(1);
  }

  const { data: rows, error: listError } = await db
    .from("portal_household_charge_records")
    .select("id, row_data, status")
    .eq("manager_user_id", managerUserId);
  if (listError) {
    console.error(listError.message);
    process.exit(1);
  }

  const now = new Date();
  const pastDue: { id: string; charge: HouseholdCharge }[] = [];
  for (const row of rows ?? []) {
    const charge = (row.row_data ?? {}) as HouseholdCharge;
    const merged: HouseholdCharge = {
      ...charge,
      id: row.id,
      status: (charge.status ?? row.status ?? "pending") as HouseholdCharge["status"],
    };
    if (isHouseholdChargeOverdue(merged, now)) {
      pastDue.push({ id: row.id, charge: merged });
    }
  }

  console.log(
    `Manager ${managerUserId} on ${projectRef}: ${pastDue.length} past-due unpaid charge(s)` +
      (args.apply ? " — applying" : " (dry-run; pass --apply to write)"),
  );
  for (const { id, charge } of pastDue) {
    console.log(
      `  ${id}  ${charge.residentEmail ?? "?"}  ${charge.amountLabel ?? "?"}  due=${charge.dueDateLabel ?? "?"}`,
    );
  }

  if (!args.apply || pastDue.length === 0) return;

  const paidAt = now.toISOString();
  for (const { id, charge } of pastDue) {
    const next: HouseholdCharge = {
      ...charge,
      status: "paid",
      paidAt,
      balanceLabel: "$0.00",
    };
    const { error } = await db
      .from("portal_household_charge_records")
      .update({
        row_data: next,
        status: "paid",
        updated_at: paidAt,
      })
      .eq("id", id)
      .eq("manager_user_id", managerUserId);
    if (error) {
      console.error(`Failed ${id}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`Marked ${pastDue.length} charge(s) paid.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
