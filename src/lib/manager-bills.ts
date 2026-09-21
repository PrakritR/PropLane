export const MANAGER_BILL_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "paid",
  "void",
] as const;

export type ManagerBillStatus = (typeof MANAGER_BILL_STATUSES)[number];

export type ManagerBill = {
  id: string;
  vendorId: string | null;
  workOrderId: string | null;
  propertyId: string | null;
  vendorInvoiceId: string | null;
  billNumber: string | null;
  description: string;
  amountCents: number;
  dueDate: string | null;
  status: ManagerBillStatus;
  categoryCode: string;
  paidExpenseEntryId: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  smsTestSessionId: string | null;
};

export const MANAGER_BILL_SELECT =
  "id, manager_user_id, vendor_id, work_order_id, property_id, vendor_invoice_id, bill_number, description, amount_cents, due_date, status, category_code, paid_expense_entry_id, approved_at, paid_at, created_at, sms_test_session_id, sms_test_actor_user_id, sms_test_manager_user_id";

export function managerBillBadgeTone(status: ManagerBillStatus): "pending" | "approved" | "confirmed" | "overdue" {
  switch (status) {
    case "draft":
    case "pending_approval":
      return "pending";
    case "approved":
    case "scheduled":
      return "approved";
    case "paid":
      return "confirmed";
    case "void":
      return "overdue";
  }
}

export function mapManagerBillRow(row: Record<string, unknown>): ManagerBill {
  return {
    id: String(row.id),
    vendorId: row.vendor_id ? String(row.vendor_id) : null,
    workOrderId: row.work_order_id ? String(row.work_order_id) : null,
    propertyId: row.property_id ? String(row.property_id) : null,
    vendorInvoiceId: row.vendor_invoice_id ? String(row.vendor_invoice_id) : null,
    billNumber: row.bill_number ? String(row.bill_number) : null,
    description: String(row.description ?? ""),
    amountCents: Number(row.amount_cents),
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null,
    status: row.status as ManagerBillStatus,
    categoryCode: String(row.category_code ?? "maintenance"),
    paidExpenseEntryId: row.paid_expense_entry_id ? String(row.paid_expense_entry_id) : null,
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    paidAt: row.paid_at ? String(row.paid_at) : null,
    createdAt: String(row.created_at),
    smsTestSessionId: row.sms_test_session_id ? String(row.sms_test_session_id) : null,
  };
}

export function apAgingBucket(daysPastDue: number): string {
  if (daysPastDue <= 0) return "Current";
  if (daysPastDue <= 30) return "1–30 days";
  if (daysPastDue <= 60) return "31–60 days";
  if (daysPastDue <= 90) return "61–90 days";
  return "90+ days";
}
