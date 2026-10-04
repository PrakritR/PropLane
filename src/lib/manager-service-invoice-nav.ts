/** Resolve a vendor invoice id for a service work order (client-side). */
export async function fetchVendorInvoiceIdForWorkOrder(
  workOrderId: string,
  status: "submitted" | "approved",
): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/manager/vendor-invoices?status=${encodeURIComponent(status)}&workOrderId=${encodeURIComponent(workOrderId)}`,
      { credentials: "include" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { invoices?: Array<{ id: string }> };
    return body.invoices?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

export function outgoingPayHref(basePath: string, invoiceId: string): string {
  const params = new URLSearchParams({ payInvoice: invoiceId });
  return `${basePath}/outgoing/to-pay?${params.toString()}`;
}

export type ServiceInvoiceSummary = {
  id: string;
  status: "submitted" | "approved" | "scheduled" | "paid" | "rejected";
  invoiceNumber: string | null;
  totalCents: number;
  paidAt: string | null;
};

/** Every vendor invoice on one service (the job's and any estimate-visit fee), any status. */
export async function fetchServiceInvoices(workOrderId: string): Promise<ServiceInvoiceSummary[]> {
  try {
    const res = await fetch(
      `/api/manager/vendor-invoices?status=submitted,approved,scheduled,paid&workOrderId=${encodeURIComponent(workOrderId)}`,
      { credentials: "include" },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { invoices?: ServiceInvoiceSummary[] };
    return (body.invoices ?? []).map((invoice) => ({
      id: invoice.id,
      status: invoice.status,
      invoiceNumber: invoice.invoiceNumber ?? null,
      totalCents: Number(invoice.totalCents) || 0,
      paidAt: invoice.paidAt ?? null,
    }));
  } catch {
    return [];
  }
}
