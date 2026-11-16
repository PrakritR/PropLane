import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { findDuplicatePayments, validOverrideReason, type DuplicateMatch, type PaymentFingerprint } from "@/lib/finance/duplicate-payment";
import { LedgerError, ownerParty, readPartyBalance, availableToWithdraw, vendorParty } from "@/lib/managed-finance/ledger.server";
import { loadBillApprovalThreshold } from "@/lib/managed-finance/splits.server";
import { gateAndPostManagedVendorBill, type VendorBillInput, type VendorBillResult } from "@/lib/managed-finance/vendor-bills.server";
import { loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";

/**
 * Bill pay on top of the party ledger, for a PropLane-managed workspace (docs/agents/owner-management.md § Payouts and splits).
 *
 * "Pay from balance" posts the existing `vendor_bill` journal: the vendor is owed and the owner is charged. No money moves at
 * Stripe until the vendor withdraws to their own account, so PropLane holds nothing new. Three guards sit in front of the post:
 *  1. the duplicate-payment guard (same vendor, same amount, same house, nearby date) refuses unless an override reason is given;
 *  2. the approval threshold (default $500, per workspace): above it the owner is asked first, the existing owner-approval gate;
 *  3. idempotency on the caller's key (the gate's `owner_expenses` source row), so a repeat posts nothing twice.
 * A self-serve workspace has no PropLane-held balance to pay from: its bills are recorded as Paid outside PropLane (Finance
 * Phase A), never moved here.
 */

const DUPLICATE_LOOKBACK_DAYS = 8;

export type PayBillInput = Omit<VendorBillInput, "sourceType" | "sourceId"> & {
  clientKey: string;
  overrideReason?: string | null;
  /** Bills auto-approved in the last 24h may total at most this many approval thresholds; past it the owner is asked. */
  dailyAutoApproveCapThresholds?: number;
};

export type PayBillResult =
  | (Extract<VendorBillResult, { status: "posted" | "pending_owner" | "declined" }> & { duplicateOverridden?: boolean })
  | { status: "duplicate"; matches: DuplicateMatch[] };

type Row = Record<string, unknown>;

/** Earlier bills to this vendor for the same amount, as payment fingerprints (declined ones do not count). */
export async function findDuplicateVendorBills(db: SupabaseClient, input: { workspaceId: string; vendorPartyId: string; amountCents: number; propertyId: string | null; sourceId: string; now?: Date }): Promise<DuplicateMatch[]> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - DUPLICATE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from("owner_expenses")
    .select("id, source_id, property_id, vendor_party_id, vendor_label, amount_cents, status, created_at")
    .eq("workspace_id", input.workspaceId)
    .eq("vendor_party_id", input.vendorPartyId)
    .eq("amount_cents", input.amountCents)
    .in("status", ["pending_owner", "auto_approved", "approved", "posted"])
    .gte("created_at", since)
    .limit(50);
  if (error) throw new LedgerError(500, "Could not check for a duplicate payment.");
  const history: PaymentFingerprint[] = ((data ?? []) as Row[])
    .filter((r) => String(r.source_id) !== input.sourceId)
    .map((r) => ({
      id: String(r.id), amountCents: Number(r.amount_cents), propertyId: (r.property_id as string | null) ?? null,
      vendorId: String(r.vendor_party_id ?? ""), payeeLabel: String(r.vendor_label ?? ""), paidDate: String(r.created_at).slice(0, 10),
    }));
  return findDuplicatePayments(
    { amountCents: input.amountCents, propertyId: input.propertyId, vendorId: input.vendorPartyId, paidDate: now.toISOString().slice(0, 10) },
    history,
  );
}

export async function payBillFromBalance(db: SupabaseClient, input: PayBillInput, now: Date = new Date()): Promise<PayBillResult> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.clientKey)) throw new LedgerError(400, "A payment needs a key.");
  const sourceId = `${input.workspaceId}:${input.clientKey}`;
  const vendorPartyId = input.vendorUserId?.trim() ? vendorParty(input.vendorUserId.trim()) : `vendor_dir:${input.vendorDirectoryId ?? ""}`;
  const override = input.overrideReason ?? null;
  const matches = await findDuplicateVendorBills(db, { workspaceId: input.workspaceId, vendorPartyId, amountCents: input.amountCents, propertyId: input.propertyId, sourceId, now });
  if (matches.length > 0 && !validOverrideReason(override)) return { status: "duplicate", matches };
  const thresholdCents = await loadBillApprovalThreshold(db, input.workspaceId);
  const bill: VendorBillInput = {
    workspaceId: input.workspaceId, vendorUserId: input.vendorUserId, vendorDirectoryId: input.vendorDirectoryId, amountCents: input.amountCents,
    title: input.title, vendorLabel: input.vendorLabel, propertyId: input.propertyId, sourceType: "manual", sourceId,
    jobHref: input.jobHref, jobDate: input.jobDate,
  };
  const result = await gateAndPostManagedVendorBill(db, bill, now, { ...(thresholdCents === null ? {} : { thresholdCents }), dailyAutoApproveCapThresholds: input.dailyAutoApproveCapThresholds });
  if (result.status === "cleared") throw new LedgerError(500, "A bill was gated but not posted.");
  return matches.length > 0 ? { ...result, duplicateOverridden: true } : result;
}

export type BillsOutlook = {
  /** What the owner can spend now: their available balance. */
  availableCents: number;
  pendingCents: number;
  /** Bills waiting on the owner's approval. */
  awaitingApprovalCents: number;
  /** External bills (utilities, the owner distribution, a cleaner paid outside) still Due in the next 30 days. */
  dueOutsideCents: number;
  /** availableCents less what is awaiting approval; negative means more is needed than is available. */
  shortfallCents: number;
};

/** Pure: the cash-needed-versus-available line. */
export function billsOutlook(input: { availableCents: number; pendingCents: number; awaitingApprovalCents: number; dueOutsideCents: number }): BillsOutlook {
  const need = input.awaitingApprovalCents + input.dueOutsideCents;
  return { ...input, shortfallCents: Math.min(0, input.availableCents - need) };
}

/**
 * The owner-of-record's view of cash needed against cash available. Bills paid outside PropLane are the manager's Due expense
 * entries (Finance Phase A) and are labelled as such in the UI; PropLane does not pay them.
 */
export async function loadBillsOutlook(db: SupabaseClient, input: { workspaceId: string; now?: Date }): Promise<BillsOutlook> {
  const now = input.now ?? new Date();
  const policy = await loadActivePolicyForWorkspace(db, input.workspaceId);
  if (!policy) throw new LedgerError(409, "This workspace is not managed by PropLane.");
  const balance = await readPartyBalance(db, "owner_payable", ownerParty(policy.ownerUserId), input.workspaceId);
  const { data: pending } = await db.from("owner_expenses").select("amount_cents").eq("workspace_id", input.workspaceId).eq("status", "pending_owner").limit(500);
  const awaiting = ((pending ?? []) as Row[]).reduce((s, r) => s + Number(r.amount_cents), 0);
  const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", input.workspaceId).maybeSingle();
  const manager = String((ws as Row | null)?.owner_user_id ?? "");
  let dueOutside = 0;
  if (manager) {
    const horizon = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const { data: due, error } = await db.from("manager_expense_entries").select("amount_cents").eq("manager_user_id", manager).eq("payment_status", "due").lte("due_date", horizon).limit(500);
    if (!error) dueOutside = ((due ?? []) as Row[]).reduce((s, r) => s + Number(r.amount_cents), 0);
  }
  return billsOutlook({ availableCents: availableToWithdraw(balance, policy.terms.reserveTargetCents), pendingCents: balance.pendingCents, awaitingApprovalCents: awaiting, dueOutsideCents: dueOutside });
}
