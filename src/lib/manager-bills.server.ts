import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerBill } from "@/lib/manager-bills";
import { mapManagerBillRow, MANAGER_BILL_SELECT } from "@/lib/manager-bills";
import { postGlBillApproved, postGlBillPaid } from "@/lib/reports/gl-posting";
import { smsTestProvenanceColumns } from "@/lib/sms/sms-test-provenance.server";

export type CreateManagerBillInput = {
  managerUserId: string;
  description: string;
  amountCents: number;
  dueDate?: string | null;
  vendorId?: string | null;
  workOrderId?: string | null;
  propertyId?: string | null;
  vendorInvoiceId?: string | null;
  categoryCode?: string;
  status?: "draft" | "pending_approval" | "approved";
};

export async function createManagerBill(db: SupabaseClient, input: CreateManagerBillInput): Promise<ManagerBill> {
  if (input.amountCents <= 0) throw new Error("Bill amount must be positive.");

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_bills")
    .insert({
      manager_user_id: input.managerUserId,
      description: input.description.trim(),
      amount_cents: input.amountCents,
      due_date: input.dueDate?.slice(0, 10) ?? null,
      vendor_id: input.vendorId ?? null,
      work_order_id: input.workOrderId ?? null,
      property_id: input.propertyId ?? null,
      vendor_invoice_id: input.vendorInvoiceId ?? null,
      category_code: input.categoryCode ?? "maintenance",
      status: input.status ?? "pending_approval",
      ...smsTestProvenanceColumns(),
      updated_at: now,
    })
    .select(MANAGER_BILL_SELECT)
    .single();

  if (error || !data) throw new Error(error?.message ?? "Bill create failed");
  return mapManagerBillRow(data as Record<string, unknown>);
}

export async function approveManagerBill(
  db: SupabaseClient,
  managerUserId: string,
  billId: string,
  approvedBy: string,
): Promise<ManagerBill> {
  const bill = await loadBill(db, managerUserId, billId);
  if (!bill) throw new Error("Bill not found.");
  if (bill.status !== "draft" && bill.status !== "pending_approval") {
    throw new Error("Bill cannot be approved from current status.");
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_bills")
    .update({ status: "approved", approved_at: now, approved_by: approvedBy, updated_at: now, ...smsTestProvenanceColumns() })
    .eq("id", billId)
    .eq("manager_user_id", managerUserId)
    .select(MANAGER_BILL_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Approve failed");

  await postGlBillApproved(db, {
    managerUserId,
    billId,
    amountCents: bill.amountCents,
    entryDate: now.slice(0, 10),
    propertyId: bill.propertyId,
    vendorId: bill.vendorId,
    categoryCode: bill.categoryCode,
    memo: bill.description,
  });

  return mapManagerBillRow(data as Record<string, unknown>);
}

export async function payManagerBill(
  db: SupabaseClient,
  managerUserId: string,
  billId: string,
): Promise<ManagerBill> {
  const bill = await loadBill(db, managerUserId, billId);
  if (!bill) throw new Error("Bill not found.");
  if (bill.status !== "approved" && bill.status !== "scheduled") {
    throw new Error("Bill must be approved before payment.");
  }

  const now = new Date().toISOString();
  const expenseDate = now.slice(0, 10);

  const { data: expense, error: expenseError } = await db
    .from("manager_expense_entries")
    .insert({
      manager_user_id: managerUserId,
      property_id: bill.propertyId,
      vendor_id: bill.vendorId,
      category_code: bill.categoryCode,
      amount_cents: bill.amountCents,
      expense_date: expenseDate,
      memo: `Bill paid — ${bill.description}`,
      source_work_order_id: bill.workOrderId,
      updated_at: now,
    })
    .select("id")
    .single();
  if (expenseError || !expense?.id) throw new Error(expenseError?.message ?? "Expense create failed");

  const expenseId = String(expense.id);
  // Do NOT post a GL expense here: approval already booked DR expense / CR AP
  // (postGlBillApproved). Payment only settles AP, so posting the expense again
  // would double-book the expense and double-credit cash. The manager_expense_entries
  // row above still feeds the income-statement query (which reads expense entries,
  // not the GL). Payment posts DR AP / CR cash via postGlBillPaid only.
  await postGlBillPaid(db, {
    managerUserId,
    billId,
    amountCents: bill.amountCents,
    entryDate: expenseDate,
    categoryCode: bill.categoryCode,
    propertyId: bill.propertyId,
    vendorId: bill.vendorId,
    memo: bill.description,
  });

  const { data, error } = await db
    .from("manager_bills")
    .update({
      status: "paid",
      paid_at: now,
      paid_expense_entry_id: expenseId,
      updated_at: now,
      ...smsTestProvenanceColumns(),
    })
    .eq("id", billId)
    .eq("manager_user_id", managerUserId)
    .select(MANAGER_BILL_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Bill pay update failed");

  return mapManagerBillRow(data as Record<string, unknown>);
}

async function loadBill(db: SupabaseClient, managerUserId: string, billId: string): Promise<ManagerBill | null> {
  const { data, error } = await db
    .from("manager_bills")
    .select(MANAGER_BILL_SELECT)
    .eq("id", billId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapManagerBillRow(data as Record<string, unknown>) : null;
}

export async function createBillFromVendorInvoice(
  db: SupabaseClient,
  managerUserId: string,
  invoiceId: string,
): Promise<ManagerBill> {
  const { data: invoice, error } = await db
    .from("vendor_invoices")
    .select("id, vendor_id, work_order_id, total_cents, memo, bill_id, status")
    .eq("id", invoiceId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoice) throw new Error("Vendor invoice not found");
  if (invoice.status !== "approved") throw new Error("Vendor invoice must be approved before bill creation");

  let bill = invoice.bill_id ? await loadBill(db, managerUserId, String(invoice.bill_id)) : null;
  if (invoice.bill_id && !bill) throw new Error("Linked manager bill not found");

  if (!bill) {
    const loadExistingBill = async () => {
      const { data, error: existingBillError } = await db
        .from("manager_bills")
        .select(MANAGER_BILL_SELECT)
        .eq("manager_user_id", managerUserId)
        .eq("vendor_invoice_id", invoiceId)
        .limit(1)
        .maybeSingle();
      if (existingBillError) throw new Error(existingBillError.message);
      return data ? mapManagerBillRow(data as Record<string, unknown>) : null;
    };

    bill = await loadExistingBill();
    if (!bill) {
      try {
        bill = await createManagerBill(db, {
          managerUserId,
          description: String(invoice.memo ?? "Vendor invoice").trim() || "Vendor invoice",
          amountCents: Number(invoice.total_cents),
          vendorId: String(invoice.vendor_id),
          workOrderId: invoice.work_order_id ? String(invoice.work_order_id) : null,
          vendorInvoiceId: invoiceId,
          status: "approved",
        });
      } catch (createError) {
        bill = await loadExistingBill();
        if (!bill) throw createError;
      }
    }
  }

  if (!bill) {
    throw new Error("Vendor invoice bill creation failed");
  }

  if (!invoice.bill_id) {
    const { data: linkedInvoice, error: linkError } = await db
      .from("vendor_invoices")
      .update({ bill_id: bill.id, updated_at: new Date().toISOString() })
      .eq("id", invoiceId)
      .eq("manager_user_id", managerUserId)
      .eq("status", "approved")
      .is("bill_id", null)
      .select("id")
      .maybeSingle();
    if (linkError || !linkedInvoice) {
      const { data: currentInvoice, error: currentInvoiceError } = await db
        .from("vendor_invoices")
        .select("bill_id")
        .eq("id", invoiceId)
        .eq("manager_user_id", managerUserId)
        .maybeSingle();
      if (currentInvoiceError || currentInvoice?.bill_id !== bill.id) {
        throw new Error(linkError?.message ?? currentInvoiceError?.message ?? "Vendor invoice bill link failed");
      }
    }
  }

  // This bill is created already-approved (skipping approveManagerBill), so post
  // the approval GL entry (DR expense / CR AP) here — otherwise payManagerBill's
  // DR AP / CR cash would debit an AP that was never credited. Idempotent by
  // source_type + source_id.
  await postGlBillApproved(db, {
    managerUserId,
    billId: bill.id,
    amountCents: bill.amountCents,
    entryDate: new Date().toISOString().slice(0, 10),
    propertyId: bill.propertyId,
    vendorId: bill.vendorId,
    categoryCode: bill.categoryCode,
    memo: bill.description,
  });

  return bill;
}
