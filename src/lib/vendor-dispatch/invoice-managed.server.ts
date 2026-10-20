import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { gateAndPostManagedVendorBill, type VendorBillInput } from "@/lib/managed-finance/vendor-bills.server";
import { resolveManagedForProperties } from "@/lib/managed-finance/resolve.server";
import { isVendorInvoicePaymentRefusal } from "@/lib/vendor-invoices";
import { claimInvoicePayment, settleInvoicePayment } from "@/lib/vendor-invoice-settlement.server";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import type { DispatchRunRow } from "@/lib/vendor-dispatch/types";

/**
 * The manager's Y on a texted invoice (docs/agents/vendor-dispatch-agent.md § Invoice). The amount the manager approved becomes
 * the service's vendor cost (server side, from the invoice row's recomputed total, else the amount recorded when the vendor
 * texted it), so Approve + pay can never use an older agreed price. On a PropLane-managed workspace the bill is then gated on
 * the owner's repair-approval threshold (owner Y/N text) and posted to the party ledger; a self-serve workspace gets the bill
 * only (paying it still takes the manager's own checkout).
 */
export type ApprovedInvoiceOutcome = "not_managed" | "posted" | "waiting_owner" | "declined" | "unavailable";

export async function setServiceVendorCost(
  db: SupabaseClient,
  run: Pick<DispatchRunRow, "source_type" | "source_id" | "owner_user_id">,
  amountCents: number,
  nowIso: string,
): Promise<boolean> {
  if (run.source_type !== "work_order" || !Number.isSafeInteger(amountCents) || amountCents <= 0) return false;
  const { data } = await db
    .from("portal_work_order_records")
    .select("row_data")
    .eq("id", run.source_id)
    .eq("manager_user_id", run.owner_user_id)
    .maybeSingle();
  const row = (data as { row_data?: DemoManagerWorkOrderRow } | null)?.row_data;
  // A service already paid is closed: its cost is a fact now.
  if (!row || row.automationStatus === "paid" || row.paidAt) return false;
  if (row.vendorCostCents === amountCents) return true;
  const { error } = await db
    .from("portal_work_order_records")
    .update({ row_data: stampSmsTestProvenance({ ...row, vendorCostCents: amountCents } as unknown as Record<string, unknown>), updated_at: nowIso })
    .eq("id", run.source_id)
    .eq("manager_user_id", run.owner_user_id);
  return !error;
}

export async function applyApprovedDispatchInvoice(
  db: SupabaseClient,
  input: {
    run: DispatchRunRow;
    amountCents: number;
    invoiceId: string | null;
    vendorUserId: string | null;
    vendorDirectoryId: string | null;
    vendorName: string;
    now: Date;
  },
): Promise<ApprovedInvoiceOutcome> {
  const { run, amountCents, now } = input;
  if (!Number.isSafeInteger(amountCents) || amountCents < 100) return "not_managed";
  let managed: Awaited<ReturnType<typeof resolveManagedForProperties>>;
  try {
    managed = await resolveManagedForProperties(db, [run.property_id], now.toISOString());
  } catch {
    return "unavailable";
  }
  if (!managed) return "not_managed";

  // The job's own key (the work order's), the one Approve + pay posts under, so a repeat or the manager's later Approve + pay
  // posts nothing twice and a held owner approval is asked once. A job with no work order falls back to the run.
  const viaInvoice = Boolean(input.invoiceId && input.vendorUserId);
  const bill: VendorBillInput = {
    workspaceId: managed.workspaceId,
    vendorUserId: input.vendorUserId,
    vendorDirectoryId: input.vendorUserId ? null : input.vendorDirectoryId,
    amountCents,
    title: String(run.details.what || "Service").slice(0, 120),
    vendorLabel: input.vendorName || "Vendor",
    propertyId: run.property_id,
    sourceType: run.source_type === "work_order" ? "work_order" : "manual",
    sourceId: run.source_type === "work_order" ? run.source_id : `dispatch-run:${run.id}`,
    jobHref: run.source_type === "work_order" ? `/portal/services/${run.source_id}` : null,
    jobDate: now.toISOString().slice(0, 10),
  };
  try {
    const gate = await gateAndPostManagedVendorBill(db, bill, now, { gateOnly: true });
    if (gate.status === "pending_owner") return "waiting_owner";
    if (gate.status === "declined") return "declined";
    if (viaInvoice) {
      // The invoice rail's own claim keeps this and a later "pay from balance" from paying the job twice.
      try {
        await claimInvoicePayment(db, run.owner_user_id, input.invoiceId!, "balance");
      } catch (error) {
        if (isVendorInvoicePaymentRefusal(error)) return "unavailable";
        throw error;
      }
      await gateAndPostManagedVendorBill(db, bill, now);
      await settleInvoicePayment(db, run.owner_user_id, input.invoiceId!, "balance");
      return "posted";
    }
    await gateAndPostManagedVendorBill(db, bill, now);
    return "posted";
  } catch (error) {
    console.error("dispatch invoice not posted to the managed ledger", error instanceof Error ? error.message : "unknown");
    return "unavailable";
  }
}
