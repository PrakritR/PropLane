import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { alertManagerOfOwnerEvent } from "@/lib/owner-management/alerts.server";
import { loadActivePolicyForWorkspace, type PolicyRow } from "@/lib/owner-management/policies.server";
import { pacificDayKey } from "@/lib/house-groups/time";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { LedgerError, ownerParty, postJournal, vendorDirectoryParty, vendorParty } from "@/lib/managed-finance/ledger.server";
import { resolveManagedForProperties } from "@/lib/managed-finance/resolve.server";

/**
 * A managed workspace's vendor bill (an approved service, invoice, tour host fee, cleaning). PropLane pays the vendor from its
 * own balance: the vendor is owed, the owner is charged. Nothing moves at Stripe until the vendor withdraws, and an owner balance
 * that goes negative is recovered from the next rent. A bill above the owner's repair amount posts only after the owner says yes.
 */

export type VendorBillInput = {
  workspaceId: string;
  vendorUserId?: string | null;
  vendorDirectoryId?: string | null;
  amountCents: number;
  title: string;
  vendorLabel: string;
  propertyId: string | null;
  sourceType: "work_order" | "invoice" | "manual";
  sourceId: string;
  /** Where the owner can open the job (a record link), and the job's date. Shown on the owner's statement. */
  jobHref?: string | null;
  jobDate?: string | null;
};

export type VendorBillResult =
  | { status: "posted"; journalId: string; created: boolean }
  /** Gate-only mode: the owner's approval is in place (or not needed); nothing has been posted yet. */
  | { status: "cleared"; expenseId: string }
  | { status: "pending_owner"; expenseId: string }
  | { status: "declined"; expenseId: string };

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** GSM-7 safe, no emoji or curly quotes, bounded: the owner's approval text is read on a phone. */
export function approvalText(input: { title: string; house: string; amountCents: number; vendorLabel: string }): string {
  const clean = (s: string, max: number) =>
    s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  const dollars = `$${(input.amountCents / 100).toFixed(input.amountCents % 100 === 0 ? 0 : 2)}`;
  const vendor = clean(input.vendorLabel, 28);
  return `${clean(input.title, 36)} at ${clean(input.house, 30)}, ${dollars}${vendor ? ` from ${vendor}` : ""}. Approve? Y/N`;
}

export function vendorPartyFor(input: Pick<VendorBillInput, "vendorUserId" | "vendorDirectoryId">): string {
  if (input.vendorUserId?.trim()) return vendorParty(input.vendorUserId.trim());
  if (input.vendorDirectoryId?.trim()) return vendorDirectoryParty(input.vendorDirectoryId.trim());
  throw new LedgerError(400, "A vendor bill needs a vendor.");
}

async function workspaceOwnerId(db: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  return str((data as Row | null)?.owner_user_id) || null;
}

async function postBill(db: SupabaseClient, policy: PolicyRow, input: VendorBillInput, expenseId: string | null) {
  const posted = await postJournal(db, {
    workspaceId: policy.workspaceId,
    kind: "vendor_bill",
    key: `vendor-bill:${input.sourceType}:${input.sourceId}`,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    detail: {
      vendor_label: input.vendorLabel, title: input.title, property_id: input.propertyId, job_href: input.jobHref ?? null,
      job_date: input.jobDate ?? null, amount_cents: input.amountCents, expense_id: expenseId,
    },
    lines: [
      { account: "owner_payable", party_id: ownerParty(policy.ownerUserId), workspace_id: policy.workspaceId, amount_cents: input.amountCents },
      { account: "vendor_payable", party_id: vendorPartyFor(input), workspace_id: policy.workspaceId, amount_cents: -input.amountCents },
    ],
  });
  if (expenseId) {
    await db.from("owner_expenses").update({ status: "posted", posted_journal_id: posted.journalId, updated_at: new Date().toISOString() }).eq("id", expenseId);
  }
  return posted;
}

/**
 * Gate and post one managed vendor bill, idempotent on (source type, source id). The policy, owner and threshold are read
 * fresh; the workspace is verified against the bill's house by the caller via `resolveManagedForProperties`.
 */
export async function gateAndPostManagedVendorBill(
  db: SupabaseClient,
  input: VendorBillInput,
  now: Date = new Date(),
  opts: { gateOnly?: boolean } = {},
): Promise<VendorBillResult> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 100) throw new LedgerError(400, "A vendor bill must be at least $1.00.");
  if (!input.sourceId.trim()) throw new LedgerError(400, "A vendor bill needs a source.");
  const policy = await loadActivePolicyForWorkspace(db, input.workspaceId, pacificDayKey(now));
  if (!policy) throw new LedgerError(409, "This workspace is not managed by PropLane.");
  if (input.propertyId) {
    const check = await resolveManagedForProperties(db, [input.propertyId], now.toISOString());
    if (!check || check.workspaceId !== policy.workspaceId) throw new LedgerError(409, "This house is not in that managed workspace.");
  }
  vendorPartyFor(input);

  const { data: existing, error: existingError } = await db
    .from("owner_expenses")
    .select("id, status, amount_cents")
    .eq("source_type", input.sourceType)
    .eq("source_id", input.sourceId)
    .maybeSingle();
  if (existingError) throw new LedgerError(500, "Could not read the repair approval.");
  let expense = existing as { id: string; status: string; amount_cents: number } | null;
  if (expense && expense.amount_cents !== input.amountCents && expense.status !== "posted") {
    // The amount changed after the owner was asked: that is a new question, not the old yes.
    await db.from("owner_expenses").delete().eq("id", expense.id).in("status", ["pending_owner", "declined", "auto_approved", "approved"]);
    expense = null;
  }

  if (!expense) {
    const auto = input.amountCents <= policy.terms.repairApprovalThresholdCents;
    const { data, error } = await db
      .from("owner_expenses")
      .insert({
        policy_id: policy.id, workspace_id: policy.workspaceId, property_id: input.propertyId, owner_user_id: policy.ownerUserId,
        source_type: input.sourceType, source_id: input.sourceId, vendor_party_id: vendorPartyFor(input), title: input.title.slice(0, 120),
        vendor_label: input.vendorLabel.slice(0, 120), amount_cents: input.amountCents, threshold_cents: policy.terms.repairApprovalThresholdCents,
        status: auto ? "auto_approved" : "pending_owner", decided_at: auto ? now.toISOString() : null, decided_via: auto ? "auto" : null,
      })
      .select("id, status, amount_cents")
      .single();
    if (error || !data) {
      if (String(error?.code) === "23505") return gateAndPostManagedVendorBill(db, input, now, opts); // raced: re-read
      throw new LedgerError(500, "Could not record the repair approval.");
    }
    expense = data as { id: string; status: string; amount_cents: number };
    if (!auto) await askOwnerToApprove(db, policy, input, expense.id, now);
  }

  if (expense.status === "pending_owner") return { status: "pending_owner", expenseId: expense.id };
  if (expense.status === "declined") return { status: "declined", expenseId: expense.id };
  if (opts.gateOnly && expense.status !== "posted") return { status: "cleared", expenseId: expense.id };
  const posted = await postBill(db, policy, input, expense.id);
  return { status: "posted", journalId: posted.journalId, created: posted.created };
}

async function askOwnerToApprove(db: SupabaseClient, policy: PolicyRow, input: VendorBillInput, expenseId: string, now: Date): Promise<void> {
  const managerUserId = await workspaceOwnerId(db, policy.workspaceId);
  if (!managerUserId) return;
  const display = await loadManagerReportDisplayContext(db, managerUserId).catch(() => null);
  const house = (input.propertyId && display?.propertyLabel(input.propertyId)) || "your house";
  const body = approvalText({ title: input.title, house, amountCents: input.amountCents, vendorLabel: input.vendorLabel });
  const { data: profile } = await db.from("profiles").select("phone, phone_verified_at").eq("id", policy.ownerUserId).maybeSingle();
  const p = (profile ?? {}) as Row;
  const phoneKey = p.phone_verified_at ? normalizeE164(str(p.phone)) : null;
  if (phoneKey) {
    const sent = await sendWorkspacePhoneText(db, {
      workspaceId: policy.workspaceId, phoneKey, body, role: "manager", idempotencyKey: `owner-expense-ask:${expenseId}`,
    }).catch(() => false);
    if (sent) {
      await db.from("owner_expenses").update({ approval_phone_key: phoneKey, approval_sent_at: now.toISOString() }).eq("id", expenseId);
    }
  }
  await sendManagerNoticeEmail(db, {
    recipientUserId: policy.ownerUserId, ownerUserId: managerUserId, workspaceId: policy.workspaceId,
    subject: "Repair approval needed", text: `${body.replace(/ Approve\? Y\/N$/, "")}. Approve or decline in your PropLane Finances.`,
    url: `/portal/owner/finances?workspace=${policy.workspaceId}&approve=${expenseId}`, idempotencyKey: `owner-expense-ask:${expenseId}`,
  }).catch(() => undefined);
}

export type ExpenseDecision = { status: "approved" | "declined" | "already_decided" | "not_found"; expenseId?: string };

/**
 * The owner's yes or no, from a text or the portal. The owner is the caller (a verified phone or session), never a body field:
 * the expense must be theirs, still pending, in a workspace where they are the owner of record.
 */
export async function decideOwnerExpense(
  db: SupabaseClient,
  input: { expenseId: string; ownerUserId: string; approve: boolean; via: "sms" | "portal" },
  now: Date = new Date(),
): Promise<ExpenseDecision> {
  const { data, error } = await db
    .from("owner_expenses")
    .select("id, workspace_id, owner_user_id, status, amount_cents, title, property_id")
    .eq("id", input.expenseId)
    .maybeSingle();
  if (error) throw new LedgerError(500, "Could not read the repair approval.");
  const row = data as Row | null;
  if (!row || str(row.owner_user_id) !== input.ownerUserId) return { status: "not_found" };
  const policy = await loadActivePolicyForWorkspace(db, str(row.workspace_id));
  if (!policy || policy.ownerUserId !== input.ownerUserId) return { status: "not_found" };
  if (str(row.status) !== "pending_owner") return { status: "already_decided", expenseId: str(row.id) };
  const { data: updated, error: updateError } = await db
    .from("owner_expenses")
    .update({ status: input.approve ? "approved" : "declined", decided_at: now.toISOString(), decided_via: input.via, updated_at: now.toISOString() })
    .eq("id", str(row.id))
    .eq("owner_user_id", input.ownerUserId)
    .eq("status", "pending_owner")
    .select("id")
    .maybeSingle();
  if (updateError) throw new LedgerError(500, "Could not record the decision.");
  if (!updated) return { status: "already_decided", expenseId: str(row.id) };
  const managerUserId = await workspaceOwnerId(db, str(row.workspace_id));
  if (managerUserId) {
    await alertManagerOfOwnerEvent(db, {
      managerUserId, workspaceId: str(row.workspace_id), propertyId: str(row.property_id) || null,
      subject: input.approve ? "Owner approved a repair" : "Owner declined a repair",
      text: `${str(row.title)} ($${(Number(row.amount_cents) / 100).toFixed(2)}) was ${input.approve ? "approved. Approve and pay it to continue" : "declined"}.`,
      key: `expense-decision:${str(row.id)}`,
    });
  }
  return { status: input.approve ? "approved" : "declined", expenseId: str(row.id) };
}

export type PendingExpense = { id: string; workspaceId: string; title: string; vendorLabel: string; amountCents: number; propertyId: string | null; requestedAt: string };

export async function listPendingExpensesForOwner(db: SupabaseClient, ownerUserId: string, workspaceId?: string): Promise<PendingExpense[]> {
  let q = db
    .from("owner_expenses")
    .select("id, workspace_id, title, vendor_label, amount_cents, property_id, requested_at")
    .eq("owner_user_id", ownerUserId)
    .eq("status", "pending_owner")
    .order("requested_at", { ascending: true })
    .limit(50);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data, error } = await q;
  if (error) {
    if (String(error.code) === "42P01" || String(error.code) === "PGRST205") return [];
    throw new LedgerError(500, "Could not read repair approvals.");
  }
  return ((data ?? []) as Row[]).map((r) => ({
    id: str(r.id), workspaceId: str(r.workspace_id), title: str(r.title), vendorLabel: str(r.vendor_label), amountCents: Number(r.amount_cents),
    propertyId: str(r.property_id) || null, requestedAt: str(r.requested_at),
  }));
}

/** Approve every pending repair at or under `capCents` for the owner ("approve all routine repairs under $X"). */
export async function approveRoutineExpenses(db: SupabaseClient, ownerUserId: string, workspaceId: string, capCents: number): Promise<number> {
  if (!Number.isSafeInteger(capCents) || capCents < 0) throw new LedgerError(400, "Enter an amount.");
  const pending = await listPendingExpensesForOwner(db, ownerUserId, workspaceId);
  let approved = 0;
  for (const e of pending.filter((p) => p.amountCents <= capCents)) {
    const r = await decideOwnerExpense(db, { expenseId: e.id, ownerUserId, approve: true, via: "portal" });
    if (r.status === "approved") approved += 1;
  }
  return approved;
}

/** The managed workspace (if any) an invoice's house belongs to: its work order's house, else its bill's. */
export async function resolveManagedForVendorInvoice(
  db: SupabaseClient,
  invoice: { work_order_id?: string | null; bill_id?: string | null },
): Promise<{ resolution: Awaited<ReturnType<typeof resolveManagedForProperties>>; propertyId: string | null }> {
  let propertyId: string | null = null;
  if (invoice.work_order_id) {
    const { data, error } = await db.from("portal_work_order_records").select("row_data").eq("id", invoice.work_order_id).maybeSingle();
    if (error) throw new LedgerError(500, "Could not read the invoice's service.");
    const rd = ((data as Row | null)?.row_data ?? {}) as { propertyId?: string; assignedPropertyId?: string };
    propertyId = str(rd.propertyId) || str(rd.assignedPropertyId) || null;
  } else if (invoice.bill_id) {
    const { data, error } = await db.from("manager_bills").select("property_id").eq("id", invoice.bill_id).maybeSingle();
    if (error) throw new LedgerError(500, "Could not read the invoice's bill.");
    propertyId = str((data as Row | null)?.property_id) || null;
  }
  if (!propertyId) return { resolution: null, propertyId: null };
  return { resolution: await resolveManagedForProperties(db, [propertyId], new Date().toISOString()), propertyId };
}
