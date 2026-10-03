"use client";

import { PopupRecordPreview } from "@/components/portal/popup-live-preview";

/**
 * VD48/VD49 — the manager's in-app "Pay" screen for a vendor invoice
 * (`vendor_invoices`, gated on VENDOR_BANKING_ENABLED). Posts to
 * `POST /api/vendor/invoices/[id]/pay` for a Stripe EMBEDDED Checkout client
 * secret (never a hosted redirect), shows the invoice's own line items and
 * the same PropLane fee disclosure the vendor sees on their side, then mounts
 * `StripeEmbeddedCheckout` — the card/ACH form renders INSIDE this modal.
 * The captain's "never leave the app" rule: Stripe's own `return_url`
 * navigation on completion lands back on `/portal/finances`, never
 * checkout.stripe.com.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";

export type VendorInvoicePayLineItem = { description: string; quantity: number; amountCents: number };

export type VendorInvoicePayTarget = {
  id: string;
  vendorName: string;
  invoiceNumber: string | null;
  totalCents: number;
  memo?: string | null;
  lineItems?: VendorInvoicePayLineItem[];
};

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function VendorInvoiceManagerPaySheet({
  invoice,
  onClose,
}: {
  invoice: VendorInvoicePayTarget | null;
  onClose: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [platformFeeCents, setPlatformFeeCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const invoiceId = invoice?.id ?? null;

  const start = useCallback(async () => {
    if (!invoiceId || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setClientSecret(null);
    try {
      const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(invoiceId)}/pay`, { method: "POST", credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as {
        clientSecret?: string;
        platformFeeCents?: number;
        error?: string;
      };
      if (!res.ok || !body.clientSecret) {
        setError(body.error ?? "Could not start this payment.");
        return;
      }
      setClientSecret(body.clientSecret);
      setPlatformFeeCents(body.platformFeeCents ?? 0);
    } catch {
      setError("Could not start this payment. Nothing has been charged.");
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [invoiceId]);

  useEffect(() => {
    if (invoiceId) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  const netToVendorCents = invoice ? Math.max(0, invoice.totalCents - platformFeeCents) : 0;
  // Derived from the server's own response (never re-read from an env var
  // client-side, which would be `undefined` in the browser bundle) — 0 until
  // the checkout starts, then the real bps this specific payment charged.
  const feePercent = invoice && invoice.totalCents > 0 ? Math.round((platformFeeCents / invoice.totalCents) * 1000) / 10 : 0;

  return (
    <Modal
      open={Boolean(invoice)}
      title={invoice?.invoiceNumber ? `Pay invoice ${invoice.invoiceNumber}` : "Pay invoice"}
      onClose={onClose}
      assistantStrip={false}
      contextPanel={<PopupRecordPreview rows={[{ label: "Vendor", value: invoice?.vendorName }, { label: "Invoice", value: invoice?.invoiceNumber }]} />}
      previewLabel="Payment preview"
      preview={invoice ? <PopupRecordPreview rows={[{ label: "Invoice amount", value: formatMoney(invoice.totalCents) }, ...invoice.lineItems.map((line, index) => ({ label: `${index + 1}. ${line.description || "Line item"}`, value: formatMoney(line.amountCents) }))]} /> : undefined}
      scrollableContent
      panelClassName={MODAL_LARGE_PANEL_CLASS}
    >
      {invoice ? (
        <div className="space-y-4" data-attr="vendor-invoice-pay-sheet">
          <div className="rounded-xl border border-border bg-accent/30 p-4 text-sm" data-attr="vendor-invoice-pay-summary">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-foreground">{invoice.vendorName}</span>
              <span className="font-semibold text-foreground">{formatMoney(invoice.totalCents)}</span>
            </div>
            {invoice.lineItems && invoice.lineItems.length > 0 ? (
              <dl className="mt-2 space-y-1 border-t border-border/70 pt-2">
                {invoice.lineItems.map((line, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 text-muted">
                    <dt className="min-w-0 truncate">
                      {line.description || "Line item"}
                      {line.quantity > 1 ? ` × ${line.quantity}` : ""}
                    </dt>
                    <dd className="shrink-0 tabular-nums">{formatMoney(line.amountCents)}</dd>
                  </div>
                ))}
              </dl>
            ) : invoice.memo ? (
              <p className="mt-2 border-t border-border/70 pt-2 text-muted">{invoice.memo}</p>
            ) : null}
            {feePercent > 0 ? (
              <div className="mt-2 border-t border-border/70 pt-2 text-xs text-muted" data-attr="vendor-invoice-pay-fee-disclosure">
                You pay {formatMoney(invoice.totalCents)} plus Stripe&apos;s processing cost. PropLane&apos;s {feePercent}% fee
                ({formatMoney(platformFeeCents)}) comes out of the vendor&apos;s side — they net {formatMoney(netToVendorCents)}.
              </div>
            ) : null}
          </div>

          {loading ? <p className="text-center text-sm text-muted">Preparing secure payment…</p> : null}
          {error ? (
            <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              <p>{error}</p>
              <button
                type="button"
                className="font-semibold underline underline-offset-2"
                onClick={() => void start()}
                data-attr="vendor-invoice-pay-retry"
              >
                Try again
              </button>
            </div>
          ) : null}
          {clientSecret ? <StripeEmbeddedCheckout key={clientSecret} clientSecret={clientSecret} /> : null}
        </div>
      ) : null}
    </Modal>
  );
}
