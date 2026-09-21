/**
 * PLAN-0920-2357 stream D — Ambika (Ambika Mago) production payments cleanup.
 *
 * Removes, under Ambika's account only:
 *   1. Household charge rows the recurring-rent generator wrote a second
 *      time on top of a sales-migration import (same property, resident,
 *      and rent month) — `selectDuplicateGeneratedCharges`.
 *   2. Ledger lines belonging to those duplicate charges.
 *   3. Ledger lines left on the two deleted seed properties
 *      (mgr-seed-4709a-8th-ave-ne, mgr-seed-5259-brooklyn-ave-ne,
 *      mgr--9-rooms-b1wf3z) — `selectDeadPropertyLedgerEntries`.
 *   4. Orphan "charge" ledger lines on live properties with no linked
 *      charge row, created since 2026-09-19 — a charge-delete path that
 *      dropped the charge but left its ledger line —
 *      `selectOrphanChargeLedgerEntries`.
 *
 * Never touches `manager_property_records` and never deletes a charge row
 * that carries `row_data.migrationSourceId` (an imported row).
 *
 * Named production waiver:
 *   docs/waivers/2026-09-21-ambika-payments-cleanup.md
 *
 * Dry-run (default):
 *   node --env-file=.env.production.local \
 *     scripts/cleanup-ambika-payments-production.mjs
 *
 * Apply (writes a JSON backup first, then deletes):
 *   ALLOW_PRODUCTION_AMBIKA_PAYMENTS_CLEANUP=1 \
 *     node --env-file=.env.production.local \
 *       scripts/cleanup-ambika-payments-production.mjs --apply
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { AMBIKA_MANAGER_EMAIL, AMBIKA_MANAGER_ID, PRODUCTION_PROJECT_REF } from "@/lib/ambika-seattle-occupancy";
import {
  selectDeadPropertyLedgerEntries,
  selectDuplicateGeneratedCharges,
  selectLedgerEntriesForCharges,
  selectOrphanChargeLedgerEntries,
  summarize,
  type ChargeRow,
  type LedgerRow,
} from "@/lib/ambika-payments-cleanup";

const APPLY = process.argv.includes("--apply");
const BACKUP_DIR = process.env.AMBIKA_CLEANUP_BACKUP_DIR?.trim() || "/Users/prakrit/Downloads";

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, "").trim();
}

function targetFromUrl(raw: string): string {
  try {
    const host = new URL(raw).host;
    const hosted = /^([a-z0-9-]+)\.supabase\.(co|in|red)$/i.exec(host);
    return hosted ? hosted[1]! : host;
  } catch {
    return "";
  }
}

function check(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

const url = stripQuotes(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
const key = stripQuotes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const ref = targetFromUrl(url);
if (ref !== PRODUCTION_PROJECT_REF) {
  console.error(`Refusing: expected production project ${PRODUCTION_PROJECT_REF}, got ${ref || "(none)"}`);
  process.exit(1);
}
if (APPLY && process.env.ALLOW_PRODUCTION_AMBIKA_PAYMENTS_CLEANUP !== "1") {
  console.error("Set ALLOW_PRODUCTION_AMBIKA_PAYMENTS_CLEANUP=1 with --apply (see docs/waivers/…).");
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

function centsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function deleteByIds(table: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const batch of chunk(ids, 100)) {
    const { error } = await db.from(table).delete().eq("manager_user_id", AMBIKA_MANAGER_ID).in("id", batch);
    check(error);
  }
}

async function main() {
  const { data: profile, error: pErr } = await db
    .from("profiles")
    .select("id, email")
    .eq("id", AMBIKA_MANAGER_ID)
    .maybeSingle();
  check(pErr);
  if (!profile || String(profile.email ?? "").trim().toLowerCase() !== AMBIKA_MANAGER_EMAIL) {
    throw new Error(`Manager identity mismatch: expected ${AMBIKA_MANAGER_EMAIL}, got ${profile?.email}`);
  }

  const { data: propertyRows, error: propErr } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  check(propErr);
  const livePropertyIds = new Set((propertyRows ?? []).map((r) => String(r.id)));

  const { data: chargeRows, error: chargeErr } = await db
    .from("portal_household_charge_records")
    .select("id, resident_email, property_id, kind, status, row_data")
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  check(chargeErr);
  const charges = (chargeRows ?? []) as ChargeRow[];

  const { data: ledgerRowsRaw, error: ledgerErr } = await db
    .from("ledger_entries")
    .select("id, resident_email, property_id, entry_type, source_charge_id, amount_cents, due_date, created_at, description")
    .eq("manager_user_id", AMBIKA_MANAGER_ID);
  check(ledgerErr);
  const ledgerRows = (ledgerRowsRaw ?? []) as LedgerRow[];

  const duplicateChargeIds = selectDuplicateGeneratedCharges(charges);
  const deadPropertyLedgerIds = selectDeadPropertyLedgerEntries(ledgerRows, livePropertyIds);
  const orphanChargeLedgerIds = selectOrphanChargeLedgerEntries(ledgerRows, livePropertyIds);
  const duplicateChargeLedgerIds = selectLedgerEntriesForCharges(ledgerRows, duplicateChargeIds);

  // Refuse to touch an imported row, no matter how it was selected.
  const chargeById = new Map(charges.map((c) => [c.id, c]));
  for (const id of duplicateChargeIds) {
    const row = chargeById.get(id);
    if (!row) throw new Error(`Refusing: selected charge ${id} is not one of the manager's rows`);
    if (row.row_data?.migrationSourceId) {
      throw new Error(`Refusing: selected charge ${id} carries migrationSourceId — never delete an imported row`);
    }
  }

  const summary = summarize(
    duplicateChargeIds,
    deadPropertyLedgerIds,
    orphanChargeLedgerIds,
    duplicateChargeLedgerIds,
    ledgerRows,
  );

  const ledgerIdToDelete = new Set<string>([...deadPropertyLedgerIds, ...orphanChargeLedgerIds, ...duplicateChargeLedgerIds]);
  const ledgerRowById = new Map(ledgerRows.map((r) => [r.id, r]));

  console.log(`Target: production ${ref} · Ambika ${AMBIKA_MANAGER_EMAIL}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  console.log(`\nDuplicate generated charges (${summary.duplicateGeneratedCharges.count}):`);
  for (const id of duplicateChargeIds) {
    const row = chargeById.get(id)!;
    const rentMonth = row.row_data?.rentMonth ?? "?";
    console.log(`  ${id} · ${row.resident_email ?? "?"} · ${row.kind ?? "?"} · ${rentMonth} · ${row.status ?? "?"}`);
  }

  console.log(
    `\nLedger lines on dead (deleted seed) properties (${summary.deadPropertyLedgerEntries.count}, ${centsLabel(summary.deadPropertyLedgerEntries.amountCents)}):`,
  );
  for (const id of deadPropertyLedgerIds) {
    const row = ledgerRowById.get(id)!;
    console.log(
      `  ${id} · ${row.resident_email ?? "?"} · ${row.description ?? "?"} · ${centsLabel(row.amount_cents ?? 0)} · due ${row.due_date ?? "?"}`,
    );
  }

  console.log(
    `\nOrphan charge ledger lines on live properties, since 2026-09-19 (${summary.orphanChargeLedgerEntries.count}, ${centsLabel(summary.orphanChargeLedgerEntries.amountCents)}):`,
  );
  for (const id of orphanChargeLedgerIds) {
    const row = ledgerRowById.get(id)!;
    console.log(
      `  ${id} · ${row.resident_email ?? "?"} · ${row.description ?? "?"} · ${centsLabel(row.amount_cents ?? 0)} · due ${row.due_date ?? "?"}`,
    );
  }

  console.log(
    `\nLedger lines for the duplicate generated charges above (${summary.duplicateChargeLedgerEntries.count}, ${centsLabel(summary.duplicateChargeLedgerEntries.amountCents)}):`,
  );
  for (const id of duplicateChargeLedgerIds) {
    const row = ledgerRowById.get(id)!;
    console.log(
      `  ${id} · ${row.resident_email ?? "?"} · ${row.description ?? "?"} · ${centsLabel(row.amount_cents ?? 0)} · due ${row.due_date ?? "?"}`,
    );
  }

  const totalCharges = duplicateChargeIds.length;
  const totalLedger = ledgerIdToDelete.size;
  console.log(`\nTotals: ${totalCharges} charge row(s), ${totalLedger} ledger row(s).`);

  if (!APPLY) {
    console.log("\nDRY RUN — pass --apply with ALLOW_PRODUCTION_AMBIKA_PAYMENTS_CLEANUP=1 to delete.");
    console.log("No manager_property_records writes, ever.");
    return;
  }

  const backupPayload = {
    generatedAt: new Date().toISOString(),
    manager: AMBIKA_MANAGER_EMAIL,
    managerUserId: AMBIKA_MANAGER_ID,
    charges: duplicateChargeIds.map((id) => chargeById.get(id)),
    ledgerEntries: [...ledgerIdToDelete].map((id) => ledgerRowById.get(id)),
  };
  const backupPath = `${BACKUP_DIR}/ambika-payments-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, JSON.stringify(backupPayload, null, 2));
  if (!existsSync(backupPath)) {
    throw new Error(`Backup write failed: ${backupPath} does not exist after write`);
  }
  const verify = JSON.parse(readFileSync(backupPath, "utf8"));
  if (!Array.isArray(verify.charges) || !Array.isArray(verify.ledgerEntries)) {
    throw new Error(`Backup file ${backupPath} did not parse back into the expected shape`);
  }
  console.log(`\nBackup written: ${backupPath}`);

  // Ledger rows first (they may reference the charge rows), then charges.
  await deleteByIds("ledger_entries", [...ledgerIdToDelete]);
  console.log(`Deleted ${ledgerIdToDelete.size} ledger row(s).`);
  await deleteByIds("portal_household_charge_records", duplicateChargeIds);
  console.log(`Deleted ${duplicateChargeIds.length} charge row(s).`);

  const { count: remainingCharges } = await db
    .from("portal_household_charge_records")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", AMBIKA_MANAGER_ID)
    .in("id", duplicateChargeIds.length ? duplicateChargeIds : ["__none__"]);
  const { count: remainingLedger } = await db
    .from("ledger_entries")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", AMBIKA_MANAGER_ID)
    .in("id", ledgerIdToDelete.size ? [...ledgerIdToDelete] : ["__none__"]);

  console.log("\nAPPLY complete.");
  console.log(`Remaining selected charge rows still present: ${remainingCharges ?? 0} (expect 0)`);
  console.log(`Remaining selected ledger rows still present: ${remainingLedger ?? 0} (expect 0)`);
  console.log("Check Ambika Payments and the Financials ledger for the affected properties.");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
