import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type ClassifiedSpendPart = {
  hold_id: string; source_id: string; source_net_cents: number;
};

function exactCents(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Classified source has an invalid amount.");
  }
  return amount;
}

function partsFromFrozen(value: unknown, amountCents: number): ClassifiedSpendPart[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) =>
    typeof part?.hold_id !== "string" || !part.hold_id ||
    typeof part?.source_id !== "string" || !part.source_id ||
    !Number.isSafeInteger(part?.source_net_cents) || part.source_net_cents <= 0) ||
    value.reduce((sum, part) => sum + part.source_net_cents, 0) !== amountCents) {
    throw new Error("Existing classified spend has incomplete frozen source terms.");
  }
  return value as ClassifiedSpendPart[];
}

/** A same-key retry must pass its original source vector back to the atomic
 * mover, even if that vector has since been completely consumed. */
export async function existingClassifiedSpendParts(
  db: SupabaseClient, payerAccountId: string, root: string, amountCents: number,
): Promise<ClassifiedSpendPart[] | null> {
  const { data, error } = await db.from("proplane_balance_entries")
    .select("account_id,amount_cents,kind,status,source_spend_breakdown")
    .eq("idempotency_key", `${root}:out`).maybeSingle();
  if (error) throw new Error("Could not read the existing classified spend.");
  if (!data) return null;
  if (data.account_id !== payerAccountId || data.amount_cents !== -amountCents ||
      data.kind !== "vendor_payment_out" || data.status !== "available") {
    throw new Error("Existing balance move differs from its claimed payment.");
  }
  return partsFromFrozen(data.source_spend_breakdown, amountCents);
}

/** Select an exact income vector from cleared classified mirrors. This is a
 * proposal only: platform_balance_move_from_sources locks owner, charge, PI,
 * hold and wallets and rechecks every component inside its one transaction. */
async function selectManagerClassifiedParts(
  db: SupabaseClient, payerAccountId: string, ownerUserId: string, amountCents: number,
  allowedClasses: ReadonlyArray<"income" | "deposit">,
): Promise<{ parts: ClassifiedSpendPart[]; eligibleCents: number }> {
  if (!ownerUserId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("Classified spend has invalid owner or amount.");
  }
  const { data: mirrors, error } = await db.from("proplane_balance_entries")
    .select("source_hold_id,source_component_id,source_liability_class,amount_cents,stripe_object_id,available_on")
    .eq("account_id", payerAccountId).eq("kind", "resident_payment")
    .eq("status", "available").in("source_liability_class", allowedClasses)
    .order("available_on", { ascending: true }).limit(501);
  if (error) throw new Error("Could not read cleared classified income.");
  if ((mirrors ?? []).length > 500) {
    throw new Error("Classified income exceeds the bounded source selection window.");
  }
  const candidates: Array<ClassifiedSpendPart & { free: number; availableOn: string }> = [];
  const now = Date.now();
  for (const mirror of mirrors ?? []) {
    if (!mirror.source_hold_id || !mirror.source_component_id ||
        !mirror.available_on || Date.parse(mirror.available_on) > now) continue;
    const { data: hold, error: holdError } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,status,source_verified_at,source_allocation_mode,stripe_charge_id,source_components,amount_cents")
      .eq("id", mirror.source_hold_id).maybeSingle();
    if (holdError || !hold || hold.owner_user_id !== ownerUserId ||
        hold.owner_role !== "manager" || hold.status !== "classified_held" ||
        hold.source_allocation_mode !== "hold" || !hold.source_verified_at ||
        hold.stripe_charge_id !== mirror.stripe_object_id ||
        !Array.isArray(hold.source_components)) continue;
    const component = hold.source_components.find((part: { source_id?: string }) =>
      part.source_id === mirror.source_component_id);
    if (!component || !allowedClasses.includes(component.liability_class) ||
        component.liability_class !== mirror.source_liability_class ||
        exactCents(component.recipient_net_cents) !== exactCents(mirror.amount_cents)) continue;
    const [{ data: refunds, error: refundError }, { data: consumption, error: consumptionError },
      { data: transfers, error: transferError }, { data: reversals, error: reversalError }] = await Promise.all([
      db.from("platform_hold_refund_attempts")
        .select("status,reversal_status,recipient_debit_components").eq("hold_id", hold.id),
      db.from("platform_source_consumption_legs")
        .select("source_component_id,source_net_cents,status").eq("hold_id", hold.id),
      db.from("platform_hold_transfer_attempts")
        .select("status,component_breakdown").eq("hold_id", hold.id),
      db.from("platform_hold_refund_transfer_legs")
        .select("status,component_breakdown").eq("hold_id", hold.id),
    ]);
    if (refundError || consumptionError || transferError || reversalError) {
      throw new Error("Could not read classified source reservations.");
    }
    if ((refunds ?? []).some((row) => row.status === "reserved" ||
        (row.status === "succeeded" && (!Array.isArray(row.recipient_debit_components) ||
          ["pending", "shortfall"].includes(row.reversal_status ?? "")))) ||
        (transfers ?? []).some((row) => row.status === "reserved") ||
        (consumption ?? []).some((row) => row.source_component_id === mirror.source_component_id &&
          row.status === "reserved")) continue;
    const sum = (rows: Array<{ status: string; component_breakdown?: unknown;
      recipient_debit_components?: unknown }>, field: "component_breakdown" | "recipient_debit_components",
      status: string, amountField: "recipient_net_cents" | "recipient_debit_cents") =>
      rows.filter((row) => row.status === status).reduce((total, row) => {
        const vector = row[field];
        if (!Array.isArray(vector)) throw new Error("Classified source vector is incomplete.");
        return total + vector.filter((part) => part.source_id === mirror.source_component_id)
          .reduce((n, part) => n + exactCents(part[amountField]), 0);
      }, 0);
    const refunded = sum(refunds ?? [], "recipient_debit_components", "succeeded", "recipient_debit_cents");
    const transferred = sum(transfers ?? [], "component_breakdown", "created", "recipient_net_cents");
    const reversed = sum(reversals ?? [], "component_breakdown", "created", "recipient_net_cents");
    const consumed = (consumption ?? []).filter((row) =>
      row.source_component_id === mirror.source_component_id &&
      ["settled", "reserved"].includes(row.status))
      .reduce((n, row) => n + exactCents(row.source_net_cents), 0);
    const free = exactCents(component.recipient_net_cents) - refunded - consumed - transferred + reversed;
    if (free < 0) throw new Error("Classified source residual is overcommitted.");
    if (free > 0) candidates.push({ hold_id: hold.id,
      source_id: mirror.source_component_id, source_net_cents: 0,
      free, availableOn: mirror.available_on });
  }
  candidates.sort((a, b) => a.availableOn.localeCompare(b.availableOn) ||
    a.hold_id.localeCompare(b.hold_id) || a.source_id.localeCompare(b.source_id));
  let remaining = amountCents;
  const parts = candidates.flatMap((candidate) => {
    if (remaining <= 0) return [];
    const take = Math.min(remaining, candidate.free);
    remaining -= take;
    return [{ hold_id: candidate.hold_id, source_id: candidate.source_id,
      source_net_cents: take }];
  });
  return { parts, eligibleCents: candidates.reduce((n, part) => n + part.free, 0) };
}

export async function selectClassifiedSpendParts(
  db: SupabaseClient, payerAccountId: string, ownerUserId: string, amountCents: number,
): Promise<{ parts: ClassifiedSpendPart[]; eligibleCents: number }> {
  return selectManagerClassifiedParts(db, payerAccountId, ownerUserId, amountCents, ["income"]);
}

/** Bank withdrawal can draw from both income and deposit; a vendor payment
 * cannot. The SQL reservation rechecks the proposal under source locks. */
export async function selectManagerWithdrawalParts(
  db: SupabaseClient, accountId: string, ownerUserId: string, amountCents: number,
): Promise<{ parts: ClassifiedSpendPart[]; eligibleCents: number }> {
  return selectManagerClassifiedParts(db, accountId, ownerUserId, amountCents, ["income", "deposit"]);
}

export type VendorWithdrawalPart = { vendor_credit_entry_id: string; source_net_cents: number };

export async function selectVendorWithdrawalParts(
  db: SupabaseClient, accountId: string, ownerUserId: string, amountCents: number,
): Promise<{ parts: VendorWithdrawalPart[]; eligibleCents: number }> {
  if (!ownerUserId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("Classified vendor withdrawal has invalid owner or amount.");
  }
  const { data: credits, error } = await db.from("proplane_balance_entries")
    .select("id,amount_cents,related_entry_id")
    .eq("account_id", accountId).eq("kind", "vendor_payment_in")
    .eq("status", "available").order("created_at", { ascending: true }).limit(501);
  if (error) throw new Error("Could not read classified vendor earnings.");
  if ((credits ?? []).length > 500) throw new Error("Classified vendor earnings exceed the bounded selection window.");
  const candidates: Array<{ id: string; free: number }> = [];
  for (const credit of credits ?? []) {
    if (!credit.related_entry_id) continue;
    const [{ data: parent, error: parentError }, { data: legs, error: legsError },
      { data: withdrawals, error: withdrawalsError }] = await Promise.all([
      db.from("proplane_balance_entries")
        .select("id,amount_cents,kind,status,related_entry_id,source_spend_breakdown,source_income_debit_cents")
        .eq("id", credit.related_entry_id).maybeSingle(),
      db.from("platform_source_consumption_legs")
        .select("id,source_net_cents,status,beneficiary_user_id,kind")
        .eq("wallet_credit_entry_id", credit.id),
      db.from("proplane_balance_entries")
        .select("source_spend_breakdown,stripe_object_id")
        .eq("account_id", accountId).eq("kind", "withdrawal")
        .not("withdrawal_destination_account_id", "is", null),
    ]);
    if (parentError || legsError || withdrawalsError) {
      throw new Error("Could not verify classified vendor earning source.");
    }
    const credited = exactCents(credit.amount_cents);
    if (!parent || parent.kind !== "vendor_payment_out" || parent.status !== "available" ||
        parent.related_entry_id !== credit.id || parent.amount_cents !== -credited ||
        parent.source_income_debit_cents !== credited ||
        !Array.isArray(parent.source_spend_breakdown) ||
        !Array.isArray(legs) || legs.length !== parent.source_spend_breakdown.length ||
        legs.some((leg) => leg.status !== "settled" || leg.kind !== "vendor_payment" ||
          leg.beneficiary_user_id !== ownerUserId)) continue;
    const prior = (withdrawals ?? []).filter((row) =>
      typeof row.stripe_object_id !== "string" || !row.stripe_object_id.startsWith("reversed:"))
      .reduce((total, row) => total + (Array.isArray(row.source_spend_breakdown)
        ? row.source_spend_breakdown.filter((part) => part.vendor_credit_entry_id === credit.id)
          .reduce((n, part) => n + exactCents(part.source_net_cents), 0) : 0), 0);
    const free = credited - prior;
    if (free < 0) throw new Error("Classified vendor earning is overcommitted.");
    if (free > 0) candidates.push({ id: credit.id, free });
  }
  let remaining = amountCents;
  const parts = candidates.flatMap((candidate) => {
    if (remaining <= 0) return [];
    const take = Math.min(remaining, candidate.free);
    remaining -= take;
    return [{ vendor_credit_entry_id: candidate.id, source_net_cents: take }];
  });
  return { parts, eligibleCents: candidates.reduce((sum, row) => sum + row.free, 0) };
}
