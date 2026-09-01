import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  dedupeHouseholdCharges,
  duplicateHouseholdChargeIds,
} from "@/lib/household-charges";
import { categoryCodeForChargeKind } from "@/lib/reports/categories";
import { postGlChargeEntry, postGlPaymentEntry } from "@/lib/reports/gl-posting";
import { receiveSecurityDeposit } from "@/lib/reports/security-deposits";
import { dollarsToCents } from "@/lib/reports/money";
import { parseMoneyAmount } from "@/lib/parse-money";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): boolean {
  return Boolean(value && UUID_RE.test(value));
}

/**
 * The DB column `manager_user_id` is set by authenticated server routes and is
 * the trustworthy owner of a charge record; `row_data.managerUserId` is
 * client-synced and can carry stale or placeholder ids (e.g. "demo-manager" or
 * a deleted user's uuid) that would break the uuid FK on ledger_entries.
 * Attribute the charge to the column owner whenever it is a real uuid.
 */
function normalizeChargeOwner(
  charge: HouseholdCharge | null,
  columnManagerUserId: string | null | undefined,
): HouseholdCharge | null {
  if (!charge) return null;
  if (isUuid(columnManagerUserId) && charge.managerUserId !== columnManagerUserId) {
    return { ...charge, managerUserId: columnManagerUserId as string };
  }
  return charge;
}

function chargeAmountCents(charge: HouseholdCharge): number {
  const raw = charge.status === "paid" ? charge.amountLabel : charge.balanceLabel || charge.amountLabel;
  return dollarsToCents(parseMoneyAmount(raw));
}

function parseIsoDate(value: string | undefined | null): string | null {
  if (!value?.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function dueDateFromCharge(charge: HouseholdCharge): string | null {
  if (charge.dueDateLabel?.trim()) {
    const parsed = parseIsoDate(charge.dueDateLabel);
    if (parsed) return parsed;
  }
  if (charge.rentMonth?.trim()) return `${charge.rentMonth}-01`;
  return parseIsoDate(charge.createdAt);
}

/** Stable fingerprint of charge fields that drive ledger/GL rows — used to skip no-op mirrors. */
export function householdChargeLedgerFingerprint(
  charge: HouseholdCharge | Record<string, unknown>,
): string {
  const c = charge as HouseholdCharge;
  return JSON.stringify({
    status: c.status ?? null,
    amountLabel: c.amountLabel ?? null,
    balanceLabel: c.balanceLabel ?? null,
    paidAt: c.paidAt ?? null,
    kind: c.kind ?? null,
    title: c.title ?? null,
    dueDateLabel: c.dueDateLabel ?? null,
    rentMonth: c.rentMonth ?? null,
    propertyId: c.propertyId ?? null,
  });
}

function throwIfLedgerError(error: { message: string } | null): void {
  if (error) throw new Error(`Ledger sync failed: ${error.message}`);
}

async function removeLedgerEntriesForChargeIds(
  db: SupabaseClient,
  chargeIds: string[],
  ownerUserId?: string,
): Promise<void> {
  if (chargeIds.length === 0) return;
  let query = db.from("ledger_entries").delete().in("source_charge_id", chargeIds);
  if (ownerUserId) query = query.eq("manager_user_id", ownerUserId);
  const { error } = await query;
  throwIfLedgerError(error);
}

async function removeDuplicateHouseholdChargeRecords(
  db: SupabaseClient,
  chargeIds: string[],
  ownerUserId?: string,
): Promise<void> {
  if (chargeIds.length === 0) return;
  let query = db.from("portal_household_charge_records").delete().in("id", chargeIds);
  if (ownerUserId) query = query.eq("manager_user_id", ownerUserId);
  const { error } = await query;
  throwIfLedgerError(error);
}

const CHARGE_SWEEP_PAGE_SIZE = 1000;

type ChargeSweepRow = { id: string; manager_user_id: string | null; row_data: unknown };

/** Pages through every matching charge record so sweeps never silently truncate. */
async function fetchAllChargeRecords(
  db: SupabaseClient,
  managerUserId?: string,
): Promise<ChargeSweepRow[]> {
  const rows: ChargeSweepRow[] = [];
  for (let offset = 0; ; offset += CHARGE_SWEEP_PAGE_SIZE) {
    let query = db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, row_data")
      .order("id", { ascending: true })
      .range(offset, offset + CHARGE_SWEEP_PAGE_SIZE - 1);
    if (managerUserId) query = query.eq("manager_user_id", managerUserId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as ChargeSweepRow[];
    rows.push(...page);
    if (page.length < CHARGE_SWEEP_PAGE_SIZE) return rows;
  }
}

/**
 * Removes duplicate application-fee charge rows and their ledger entries
 * (prevents doubled income) among the given charges — no table scan, so it is
 * safe on hot per-mutation paths where the caller already holds the charge
 * list. When `ownerUserId` is set (non-admin callers passing a client-supplied
 * charge list), deletes are scoped to rows owned by that manager so a crafted
 * duplicate pair carrying another manager's charge id cannot delete their data.
 */
export async function reconcileDuplicateChargeList(
  db: SupabaseClient,
  charges: (HouseholdCharge | null)[],
  ownerUserId?: string,
  allowedChargeIds?: Set<string>,
): Promise<{ removedChargeIds: string[] }> {
  const raw = charges.filter((charge): charge is HouseholdCharge => Boolean(charge?.id));
  const duplicateIds = allowedChargeIds
    ? duplicateHouseholdChargeIds(raw).filter((id) => allowedChargeIds.has(id))
    : duplicateHouseholdChargeIds(raw);
  if (duplicateIds.length === 0) return { removedChargeIds: [] };

  await removeLedgerEntriesForChargeIds(db, duplicateIds, ownerUserId);
  await removeDuplicateHouseholdChargeRecords(db, duplicateIds, ownerUserId);
  return { removedChargeIds: duplicateIds };
}

/** Removes duplicate application-fee charge rows and their ledger entries (prevents doubled income). */
export async function reconcileDuplicateHouseholdChargeRecords(
  db: SupabaseClient,
  managerUserId?: string,
): Promise<{ removedChargeIds: string[] }> {
  const data = await fetchAllChargeRecords(db, managerUserId);
  // `row_data.id` is attacker-influenced text, while the record's primary key is
  // not. Only ever delete ids that actually exist as record ids in the swept
  // scope, so a crafted duplicate pair cannot name an unrelated row.
  return reconcileDuplicateChargeList(
    db,
    data.map((row) => row.row_data as HouseholdCharge | null),
    managerUserId,
    new Set(data.map((row) => String(row.id))),
  );
}

type LedgerEntryRow = {
  manager_user_id: string | null;
  resident_user_id: string | null;
  resident_email: string;
  property_id: string;
  unit_label: string;
  lease_id: string | null;
  entry_type: "charge" | "payment" | "refund";
  category_code: string;
  amount_cents: number;
  due_date: string | null;
  posted_date: string;
  source_charge_id: string;
  description: string;
  stripe_checkout_session_id?: string | null;
  updated_at: string;
};

/**
 * Row for the `charge` ledger entry mirroring a household charge (null if
 * non-positive). Demo/sample charges carry placeholder ids like
 * "demo-manager" — those can't be written to the uuid columns, so they are
 * skipped (manager) or nulled (resident).
 */
function buildChargeLedgerRow(charge: HouseholdCharge): LedgerEntryRow | null {
  const amountCents = chargeAmountCents(charge);
  if (amountCents <= 0) return null;
  if (!isUuid(charge.managerUserId)) return null;
  return {
    manager_user_id: charge.managerUserId,
    resident_user_id: isUuid(charge.residentUserId) ? charge.residentUserId : null,
    resident_email: charge.residentEmail.trim().toLowerCase(),
    property_id: charge.propertyId,
    unit_label: charge.propertyLabel,
    lease_id: charge.applicationId ?? null,
    entry_type: "charge",
    category_code: categoryCodeForChargeKind(charge.kind),
    amount_cents: amountCents,
    due_date: dueDateFromCharge(charge),
    posted_date: parseIsoDate(charge.createdAt) ?? new Date().toISOString().slice(0, 10),
    source_charge_id: charge.id,
    description: charge.title,
    updated_at: new Date().toISOString(),
  };
}

/** Row for the `payment` ledger entry recording that a charge was paid (null if non-positive). */
function buildPaymentLedgerRow(
  charge: HouseholdCharge,
  paidAt?: string | null,
  stripeCheckoutSessionId?: string | null,
): LedgerEntryRow | null {
  const amountCents = dollarsToCents(parseMoneyAmount(charge.amountLabel));
  if (amountCents <= 0) return null;
  if (!isUuid(charge.managerUserId)) return null;
  return {
    manager_user_id: charge.managerUserId,
    resident_user_id: isUuid(charge.residentUserId) ? charge.residentUserId : null,
    resident_email: charge.residentEmail.trim().toLowerCase(),
    property_id: charge.propertyId,
    unit_label: charge.propertyLabel,
    lease_id: charge.applicationId ?? null,
    entry_type: "payment",
    category_code: categoryCodeForChargeKind(charge.kind),
    amount_cents: amountCents,
    due_date: dueDateFromCharge(charge),
    posted_date: parseIsoDate(paidAt ?? charge.paidAt) ?? new Date().toISOString().slice(0, 10),
    source_charge_id: charge.id,
    description: `Payment — ${charge.title}`,
    stripe_checkout_session_id: stripeCheckoutSessionId ?? null,
    updated_at: new Date().toISOString(),
  };
}

async function upsertLedgerEntryRow(db: SupabaseClient, row: LedgerEntryRow): Promise<string | null> {
  const { data: existing } = await db
    .from("ledger_entries")
    .select("id, stripe_checkout_session_id")
    .eq("source_charge_id", row.source_charge_id)
    .eq("entry_type", row.entry_type)
    .maybeSingle();

  if (existing?.id) {
    // Most re-sync paths (charge edits, the backfill sweep) rebuild the row
    // without a session id; blanking the stored one would lose the only link
    // back to the Stripe Checkout session that settled the payment.
    const update: LedgerEntryRow = {
      ...row,
      stripe_checkout_session_id:
        row.stripe_checkout_session_id ?? existing.stripe_checkout_session_id ?? null,
    };
    const { error } = await db.from("ledger_entries").update(update).eq("id", existing.id);
    throwIfLedgerError(error);
    return String(existing.id);
  }

  const { data, error } = await db.from("ledger_entries").insert(row).select("id").single();
  throwIfLedgerError(error);
  return data?.id ? String(data.id) : null;
}

async function mirrorGlForLedgerRow(
  db: SupabaseClient,
  row: LedgerEntryRow,
  ledgerEntryId: string | null,
): Promise<void> {
  if (!row.manager_user_id || !row.source_charge_id || row.amount_cents <= 0) return;

  const glBase = {
    managerUserId: row.manager_user_id,
    sourceChargeId: row.source_charge_id,
    categoryCode: row.category_code,
    amountCents: row.amount_cents,
    entryDate: row.posted_date ?? new Date().toISOString().slice(0, 10),
    propertyId: row.property_id,
    residentUserId: row.resident_user_id,
    description: row.description,
    linkLedgerEntryId: ledgerEntryId,
  };

  if (row.entry_type === "payment") {
    await postGlPaymentEntry(db, glBase);
  } else {
    await postGlChargeEntry(db, glBase);
  }
}

export async function syncLedgerChargeEntry(
  db: SupabaseClient,
  charge: HouseholdCharge,
): Promise<void> {
  const row = buildChargeLedgerRow(charge);
  if (row) {
    const ledgerEntryId = await upsertLedgerEntryRow(db, row);
    await mirrorGlForLedgerRow(db, row, ledgerEntryId);
  }

  if (charge.status === "paid") {
    await syncLedgerPaymentEntry(db, charge, charge.paidAt);
  }
}

export async function syncLedgerPaymentEntry(
  db: SupabaseClient,
  charge: HouseholdCharge,
  paidAt?: string | null,
  stripeCheckoutSessionId?: string | null,
): Promise<void> {
  const row = buildPaymentLedgerRow(charge, paidAt, stripeCheckoutSessionId);
  if (row) {
    const ledgerEntryId = await upsertLedgerEntryRow(db, row);
    await mirrorGlForLedgerRow(db, row, ledgerEntryId);

    if (charge.kind === "security_deposit") {
      await receiveSecurityDeposit(db, charge, { receivedDate: row.posted_date });
    }
  }
}

export type LedgerRefundInput = {
  managerUserId: string;
  sourceChargeId: string;
  categoryCode: string;
  amountCents: number;
  postedDate: string;
  stripeChargeId: string;
  stripeRefundId: string;
  propertyId?: string | null;
  residentUserId?: string | null;
  residentEmail?: string | null;
  description?: string | null;
};

export async function syncLedgerRefundEntry(
  db: SupabaseClient,
  input: LedgerRefundInput,
): Promise<string | null> {
  if (input.amountCents <= 0 || !isUuid(input.managerUserId)) return null;

  const row: LedgerEntryRow = {
    manager_user_id: input.managerUserId,
    resident_user_id: isUuid(input.residentUserId) ? input.residentUserId! : null,
    resident_email: (input.residentEmail ?? "").trim().toLowerCase(),
    property_id: input.propertyId ?? "",
    unit_label: "",
    lease_id: null,
    entry_type: "refund",
    category_code: input.categoryCode,
    amount_cents: input.amountCents,
    due_date: null,
    posted_date: input.postedDate,
    source_charge_id: input.sourceChargeId,
    description: input.description ?? `Refund — ${input.sourceChargeId}`,
    updated_at: new Date().toISOString(),
  };

  const ledgerId = await upsertLedgerEntryRow(db, row);
  if (ledgerId) {
    await db
      .from("ledger_entries")
      .update({ stripe_charge_id: input.stripeChargeId, updated_at: new Date().toISOString() })
      .eq("id", ledgerId);
  }
  return ledgerId;
}

/**
 * Mirror many charges into ledger entries in a bounded number of round-trips.
 * Fetches all existing entries for the batch once, then does a single batched
 * INSERT for new rows and a single batched UPSERT for changed rows — a fixed
 * ~3 round-trips regardless of volume.
 */
export async function syncDedupedCharges(
  db: SupabaseClient,
  rawCharges: HouseholdCharge[],
): Promise<number> {
  const charges = dedupeHouseholdCharges(rawCharges);
  if (charges.length === 0) return 0;

  const desired: LedgerEntryRow[] = [];
  for (const charge of charges) {
    const chargeRow = buildChargeLedgerRow(charge);
    if (chargeRow) desired.push(chargeRow);
    if (charge.status === "paid") {
      const paymentRow = buildPaymentLedgerRow(charge, charge.paidAt);
      if (paymentRow) desired.push(paymentRow);
    }
  }
  if (desired.length === 0) return 0;

  const sourceIds = [...new Set(desired.map((r) => r.source_charge_id))];
  const existingByKey = new Map<string, { id: string; stripeCheckoutSessionId: string | null }>();
  for (let i = 0; i < sourceIds.length; i += 200) {
    const slice = sourceIds.slice(i, i + 200);
    const { data, error } = await db
      .from("ledger_entries")
      .select("id, source_charge_id, entry_type, stripe_checkout_session_id")
      .in("source_charge_id", slice);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      existingByKey.set(`${row.source_charge_id}:${row.entry_type}`, {
        id: row.id,
        stripeCheckoutSessionId: row.stripe_checkout_session_id ?? null,
      });
    }
  }

  const toInsert: LedgerEntryRow[] = [];
  const toUpdate: (LedgerEntryRow & { id: string })[] = [];
  for (const row of desired) {
    const existing = existingByKey.get(`${row.source_charge_id}:${row.entry_type}`);
    if (existing) {
      // Same rule as upsertLedgerEntryRow: never blank a stored session id.
      toUpdate.push({
        ...row,
        id: existing.id,
        stripe_checkout_session_id:
          row.stripe_checkout_session_id ?? existing.stripeCheckoutSessionId ?? null,
      });
    } else {
      toInsert.push(row);
    }
  }

  if (toInsert.length) {
    const { error } = await db.from("ledger_entries").insert(toInsert);
    throwIfLedgerError(error);
  }
  if (toUpdate.length) {
    const { error } = await db.from("ledger_entries").upsert(toUpdate, { onConflict: "id" });
    throwIfLedgerError(error);
  }
  return charges.length;
}

/**
 * One-time/historical repair path — NOT called from any report route or page
 * load (that per-request `?backfill=1` pass was removed; new charges/payments
 * are mirrored at write time by syncLedgerChargeEntry/syncLedgerPaymentEntry).
 * Exposed only via the admin-gated /api/admin/backfill-ledger route so an
 * operator can sweep pre-existing charge history into the ledger once per
 * environment post-deploy.
 */
export async function backfillLedgerFromCharges(
  db: SupabaseClient,
  managerUserId?: string,
): Promise<{ synced: number; removedDuplicates: number }> {
  const { removedChargeIds } = await reconcileDuplicateHouseholdChargeRecords(db, managerUserId);

  const data = await fetchAllChargeRecords(db, managerUserId);

  const raw = data
    .map((record) => normalizeChargeOwner(record.row_data as HouseholdCharge | null, record.manager_user_id))
    .filter((charge): charge is HouseholdCharge => Boolean(charge?.id));
  const synced = await syncDedupedCharges(db, raw);
  return { synced, removedDuplicates: removedChargeIds.length };
}
