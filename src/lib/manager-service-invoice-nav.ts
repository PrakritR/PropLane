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
