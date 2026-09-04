/**
 * The one implementation of vendor invoice submission, shared by the vendor
 * portal route (`POST /api/vendor/invoices`) and the `submit_vendor_invoice`
 * agent tool so the two validation paths cannot drift. Both callers pass the
 * AUTHENTICATED vendor user id — never a client- or model-supplied one — and
 * every guard here scopes to it: the vendor can only bill a manager they are
 * linked to, a supplied work order must belong to that manager AND be assigned
 * to this vendor, and the total is always recomputed from the line items.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOwnVendorRecords, type OwnVendorRecord } from "@/lib/vendor-own-record";
import {
  normalizeLineItems,
  sumLineItemsCents,
  VENDOR_INVOICE_SELECT,
  type VendorInvoiceLineItem,
} from "@/lib/vendor-invoices";

export type VendorInvoiceSubmitErrorCode =
  | "no_linked_manager"
  | "multiple_managers"
  | "not_linked"
  | "work_order_lookup_failed"
  | "work_order_not_found"
  | "no_line_items";

export class VendorInvoiceSubmitError extends Error {
  constructor(
    public readonly code: VendorInvoiceSubmitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VendorInvoiceSubmitError";
  }
}

/** HTTP status per error code, for the route path. */
export const VENDOR_INVOICE_SUBMIT_ERROR_STATUS: Record<VendorInvoiceSubmitErrorCode, number> = {
  no_linked_manager: 400,
  multiple_managers: 409,
  not_linked: 403,
  work_order_lookup_failed: 500,
  work_order_not_found: 400,
  no_line_items: 400,
};

export type VendorLinkedManagerOption = {
  managerUserId: string;
  label: string;
};

/** Labels each manager a vendor is linked to — used by the invoice submit picker. */
export async function listVendorLinkedManagers(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<VendorLinkedManagerOption[]> {
  const links = await resolveOwnVendorRecords(db, vendorUserId);
  if (links.length === 0) return [];
  // One manager can hold more than one directory row for the same vendor, which would
  // otherwise offer that manager twice in the picker.
  const seen = new Set<string>();
  const uniqueLinks = links.filter((link) => {
    if (seen.has(link.managerUserId)) return false;
    seen.add(link.managerUserId);
    return true;
  });
  const managerIds = uniqueLinks.map((link) => link.managerUserId);
  const { data: profiles } = await db.from("profiles").select("id, full_name").in("id", managerIds);
  const nameById = new Map<string, string>();
  for (const profile of profiles ?? []) {
    const id = String(profile.id ?? "").trim();
    const name = typeof profile.full_name === "string" ? profile.full_name.trim() : "";
    if (id && name) nameById.set(id, name);
  }
  return uniqueLinks.map((link) => {
    const directoryName = typeof link.row.name === "string" ? link.row.name.trim() : "";
    const profileName = nameById.get(link.managerUserId) ?? "";
    const label = profileName || directoryName || "Property manager";
    return { managerUserId: link.managerUserId, label };
  });
}

export type VendorInvoiceSubmitInput = {
  managerUserId?: string;
  workOrderId?: string;
  lineItems?: unknown;
  taxCents?: number;
};

export type PreparedVendorInvoiceSubmission = {
  target: OwnVendorRecord;
  workOrderId: string | null;
  /** Untrusted manager/vendor-entered job title — display as plain data only. */
  workOrderTitle: string | null;
  lineItems: VendorInvoiceLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

export async function prepareVendorInvoiceSubmission(
  db: SupabaseClient,
  vendorUserId: string,
  input: VendorInvoiceSubmitInput,
): Promise<PreparedVendorInvoiceSubmission> {
  const links = await resolveOwnVendorRecords(db, vendorUserId);
  if (links.length === 0) {
    throw new VendorInvoiceSubmitError("no_linked_manager", "No linked manager found for this vendor account.");
  }
  // Multiple linked managers require an explicit picker — the UI sends
  // `managerUserId` (defaulting from the chosen work order when present).
  const linkedManagerIds = new Set(links.map((l) => l.managerUserId));
  if (!input.managerUserId && linkedManagerIds.size > 1) {
    throw new VendorInvoiceSubmitError(
      "multiple_managers",
      "Choose which manager to bill before submitting this invoice.",
    );
  }
  const target = input.managerUserId
    ? links.find((l) => l.managerUserId === input.managerUserId)
    : links[0];
  if (!target) {
    throw new VendorInvoiceSubmitError("not_linked", "You are not linked to that manager.");
  }

  // A supplied work-order id must reference a work order owned by the billed
  // manager and assigned to this vendor — never trust a supplied id to link an
  // invoice to another manager's job.
  const workOrderId = input.workOrderId?.trim() || null;
  let workOrderTitle: string | null = null;
  if (workOrderId) {
    const { data: workOrder, error } = await db
      .from("portal_work_order_records")
      .select("id, row_data")
      .eq("id", workOrderId)
      .eq("manager_user_id", target.managerUserId)
      .eq("vendor_user_id", vendorUserId)
      .maybeSingle();
    if (error) {
      throw new VendorInvoiceSubmitError(
        "work_order_lookup_failed",
        "Could not verify the work order right now. Please try again.",
      );
    }
    if (!workOrder) {
      throw new VendorInvoiceSubmitError(
        "work_order_not_found",
        "Work order not found — it must be one of your own work orders for this manager.",
      );
    }
    const rowData = (workOrder as { row_data?: unknown }).row_data;
    const title =
      rowData && typeof rowData === "object" ? (rowData as { title?: unknown }).title : null;
    workOrderTitle = typeof title === "string" && title.trim() ? title.trim() : null;
  }

  const lineItems = normalizeLineItems(input.lineItems);
  if (lineItems.length === 0) {
    throw new VendorInvoiceSubmitError("no_line_items", "At least one line item is required.");
  }
  const subtotalCents = sumLineItemsCents(lineItems);
  const taxCents = Math.max(0, Math.round(Number(input.taxCents ?? 0) || 0));
  return {
    target,
    workOrderId,
    workOrderTitle,
    lineItems,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

export function insertVendorInvoiceRow(
  db: SupabaseClient,
  prepared: PreparedVendorInvoiceSubmission,
  opts: { vendorUserId: string; invoiceNumber?: string; memo?: string; now: string },
) {
  return db
    .from("vendor_invoices")
    .insert({
      manager_user_id: prepared.target.managerUserId,
      vendor_user_id: opts.vendorUserId,
      vendor_id: prepared.target.id,
      work_order_id: prepared.workOrderId,
      invoice_number: opts.invoiceNumber?.trim() || null,
      line_items: prepared.lineItems,
      subtotal_cents: prepared.subtotalCents,
      tax_cents: prepared.taxCents,
      total_cents: prepared.totalCents,
      status: "submitted",
      memo: opts.memo?.trim() || null,
      submitted_at: opts.now,
      updated_at: opts.now,
    })
    .select(VENDOR_INVOICE_SELECT)
    .single();
}
