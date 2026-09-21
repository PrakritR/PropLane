/**
 * PLAN-0920-2357 stream D — Ambika (Ambika Mago) production payments cleanup.
 *
 * Pure selection logic for scripts/cleanup-ambika-payments-production.ts.
 * No I/O here: every function takes already-fetched rows and returns the
 * ids (and summary) the script should act on. Kept separate so the
 * selection rules are unit-testable without a database.
 *
 * Named production waiver:
 *   docs/waivers/2026-09-21-ambika-payments-cleanup.md
 */

export type ChargeRowData = {
  recurringRentProfileId?: string | null;
  migrationSourceId?: string | null;
  rentMonth?: string | null;
  paidMethod?: string | null;
  stripeCheckoutSessionId?: string | null;
};

export type ChargeRow = {
  id: string;
  resident_email: string | null;
  property_id: string | null;
  kind: string | null;
  status: string | null;
  row_data: ChargeRowData | null;
};

export type LedgerRow = {
  id: string;
  resident_email: string | null;
  property_id: string | null;
  entry_type: string | null;
  source_charge_id: string | null;
  amount_cents: number | null;
  due_date: string | null;
  created_at: string | null;
  description: string | null;
  stripe_checkout_session_id?: string | null;
};

/**
 * The exact three deleted seed properties whose ledger lines this cleanup may
 * remove. `selectDeadPropertyLedgerEntries` selects nothing outside this list —
 * a ledger line with an empty/null `property_id` (a manual one-off charge filed
 * under no property) is a live line, not a dead one.
 */
export const AMBIKA_DEAD_SEED_PROPERTY_IDS: readonly string[] = [
  "mgr-seed-4709a-8th-ave-ne",
  "mgr-seed-5259-brooklyn-ave-ne",
  "mgr--9-rooms-b1wf3z",
];

const GENERATED_KINDS = new Set(["rent", "utilities"]);

function normEmail(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Rows that were written twice: once by the recurring-rent generator
 * (`row_data.recurringRentProfileId`, kind "rent" or "utilities") and once
 * by the sales-migration import (`row_data.migrationSourceId`, kind "rent")
 * for the same property, resident, and rent month. Paid status does not
 * exempt a row — some of the real duplicates were marked paid by hand.
 */
export function selectDuplicateGeneratedCharges(rows: ChargeRow[]): string[] {
  const importedKeys = new Set<string>();
  for (const row of rows) {
    const data = row.row_data;
    if (!data?.migrationSourceId) continue;
    if (row.kind !== "rent") continue;
    const rentMonth = data.rentMonth;
    if (!rentMonth) continue;
    importedKeys.add(`${row.property_id ?? ""}::${normEmail(row.resident_email)}::${rentMonth}`);
  }

  const duplicateIds: string[] = [];
  for (const row of rows) {
    const data = row.row_data;
    if (!data?.recurringRentProfileId) continue;
    if (!row.kind || !GENERATED_KINDS.has(row.kind)) continue;
    const rentMonth = data.rentMonth;
    if (!rentMonth) continue;
    const key = `${row.property_id ?? ""}::${normEmail(row.resident_email)}::${rentMonth}`;
    if (importedKeys.has(key)) duplicateIds.push(row.id);
  }
  return duplicateIds;
}

/**
 * Ledger lines on the named deleted seed properties. Pinned to an explicit
 * allowlist (`AMBIKA_DEAD_SEED_PROPERTY_IDS` by default) rather than "anything
 * not live", and a property that is somehow live again is left alone.
 */
export function selectDeadPropertyLedgerEntries(
  ledgerRows: LedgerRow[],
  livePropertyIds: Set<string>,
  deadPropertyIds: Iterable<string> = AMBIKA_DEAD_SEED_PROPERTY_IDS,
): string[] {
  const dead = new Set(deadPropertyIds);
  return ledgerRows
    .filter((row) => {
      const propertyId = row.property_id?.trim() ?? "";
      if (!propertyId) return false;
      return dead.has(propertyId) && !livePropertyIds.has(propertyId);
    })
    .map((row) => row.id);
}

const DEFAULT_ORPHAN_SINCE_ISO = "2026-09-19T00:00:00Z";

/**
 * Charge-type ledger lines on live properties with no linked charge row
 * (`source_charge_id` null), created on/after `sinceIso` — the window a
 * charge-delete path left ledger lines behind instead of removing them.
 */
export function selectOrphanChargeLedgerEntries(
  ledgerRows: LedgerRow[],
  livePropertyIds: Set<string>,
  sinceIso: string = DEFAULT_ORPHAN_SINCE_ISO,
): string[] {
  const since = Date.parse(sinceIso);
  return ledgerRows
    .filter((row) => {
      if (row.entry_type !== "charge") return false;
      if (row.source_charge_id) return false;
      if (!livePropertyIds.has(row.property_id ?? "")) return false;
      const created = row.created_at ? Date.parse(row.created_at) : NaN;
      return Number.isFinite(created) && created >= since;
    })
    .map((row) => row.id);
}

/** Ledger lines whose `source_charge_id` points at one of the given charge ids. */
export function selectLedgerEntriesForCharges(ledgerRows: LedgerRow[], chargeIds: Iterable<string>): string[] {
  const chargeIdSet = new Set(chargeIds);
  return ledgerRows
    .filter((row) => row.source_charge_id != null && chargeIdSet.has(row.source_charge_id))
    .map((row) => row.id);
}

export type PaidDuplicatePartition = {
  /** Duplicate charges whose row is `paid` (hand-marked or otherwise). */
  paidIds: string[];
  /** Duplicate charges that show real settlement: a Stripe Checkout session on the
   *  charge or on any of its ledger lines, or `paidMethod: "card"`. */
  settledIds: string[];
};

/**
 * Splits the duplicate generated charges into the ones that were marked paid and
 * the ones that carry evidence of money actually moving through Stripe / a card.
 * The script prints both groups separately and refuses to apply while a settled
 * duplicate exists unless `ALLOW_PAID_DUPLICATE_DELETE=1`.
 */
export function partitionPaidDuplicates(
  charges: ChargeRow[],
  duplicateChargeIds: Iterable<string>,
  ledgerRows: LedgerRow[],
): PaidDuplicatePartition {
  const duplicateSet = new Set(duplicateChargeIds);
  const chargesWithStripeLedgerLine = new Set<string>();
  for (const row of ledgerRows) {
    if (row.source_charge_id && duplicateSet.has(row.source_charge_id) && row.stripe_checkout_session_id) {
      chargesWithStripeLedgerLine.add(row.source_charge_id);
    }
  }
  const paidIds: string[] = [];
  const settledIds: string[] = [];
  for (const row of charges) {
    if (!duplicateSet.has(row.id)) continue;
    if (row.status === "paid") paidIds.push(row.id);
    const data = row.row_data;
    const settled =
      Boolean(data?.stripeCheckoutSessionId) ||
      (typeof data?.paidMethod === "string" && data.paidMethod.trim().toLowerCase() === "card") ||
      chargesWithStripeLedgerLine.has(row.id);
    if (settled) settledIds.push(row.id);
  }
  return { paidIds, settledIds };
}

/**
 * The ledger lines to delete for the duplicate charges: every line of an unpaid
 * duplicate, but only the `charge` line of a paid duplicate — its `payment` /
 * `refund` lines are kept unless `allowPaidDuplicateDelete` is set.
 */
export function selectDuplicateChargeLedgerEntriesToDelete(
  ledgerRows: LedgerRow[],
  duplicateChargeIds: Iterable<string>,
  paidDuplicateChargeIds: Iterable<string>,
  allowPaidDuplicateDelete: boolean,
): string[] {
  const duplicateSet = new Set(duplicateChargeIds);
  const paidSet = new Set(paidDuplicateChargeIds);
  return ledgerRows
    .filter((row) => {
      if (row.source_charge_id == null || !duplicateSet.has(row.source_charge_id)) return false;
      if (allowPaidDuplicateDelete) return true;
      if (!paidSet.has(row.source_charge_id)) return true;
      return row.entry_type === "charge";
    })
    .map((row) => row.id);
}

export type CleanupSummary = {
  duplicateGeneratedCharges: { count: number; amountCents: number };
  deadPropertyLedgerEntries: { count: number; amountCents: number };
  orphanChargeLedgerEntries: { count: number; amountCents: number };
  duplicateChargeLedgerEntries: { count: number; amountCents: number };
};

function sumAmountCents(ledgerRows: LedgerRow[], ids: Set<string>): number {
  let total = 0;
  for (const row of ledgerRows) {
    if (ids.has(row.id)) total += row.amount_cents ?? 0;
  }
  return total;
}

/**
 * Counts and cent totals per group, for the dry-run report. Charge rows
 * have no `amount_cents` column on their own (that lives in `row_data`),
 * so the charge-group total is left at 0 and the script prints charge
 * amounts from each row's own label; ledger groups sum `amount_cents`.
 */
export function summarize(
  duplicateChargeIds: string[],
  deadPropertyLedgerIds: string[],
  orphanChargeLedgerIds: string[],
  duplicateChargeLedgerIds: string[],
  ledgerRows: LedgerRow[],
): CleanupSummary {
  const deadSet = new Set(deadPropertyLedgerIds);
  const orphanSet = new Set(orphanChargeLedgerIds);
  const dupLedgerSet = new Set(duplicateChargeLedgerIds);
  return {
    duplicateGeneratedCharges: { count: duplicateChargeIds.length, amountCents: 0 },
    deadPropertyLedgerEntries: { count: deadPropertyLedgerIds.length, amountCents: sumAmountCents(ledgerRows, deadSet) },
    orphanChargeLedgerEntries: { count: orphanChargeLedgerIds.length, amountCents: sumAmountCents(ledgerRows, orphanSet) },
    duplicateChargeLedgerEntries: {
      count: duplicateChargeLedgerIds.length,
      amountCents: sumAmountCents(ledgerRows, dupLedgerSet),
    },
  };
}
