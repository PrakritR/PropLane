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
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Button } from "@/components/ui/button";

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
  const [processingFeeCents, setProcessingFeeCents] = useState(0);
  const [totalCents, setTotalCents] = useState(0);
  const [method, setMethod] = useState<"card" | "ach">("card");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<string | null>(null);
  const requestEpoch = useRef(0);
  const invoiceId = invoice?.id ?? null;
  const currentInvoiceId = useRef(invoiceId);
  currentInvoiceId.current = invoiceId;

  const start = useCallback(async () => {
    if (!invoiceId || inFlight.current === invoiceId) return;
    const epoch = ++requestEpoch.current;
    inFlight.current = invoiceId;
    const current = () => currentInvoiceId.current === invoiceId && requestEpoch.current === epoch;
    setLoading(true);
    setError(null);
    setClientSecret(null);
    try {
      const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(invoiceId)}/pay`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethod: method }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        clientSecret?: string;
        platformFeeCents?: number;
        processingFeeCents?: number;
        totalCents?: number;
        error?: string;
      };
      if (!current()) return;
      if (!res.ok || !body.clientSecret) {
        setError(body.error ?? "Could not start this payment.");
        return;
      }
      setClientSecret(body.clientSecret);
      setPlatformFeeCents(body.platformFeeCents ?? 0);
      setProcessingFeeCents(body.processingFeeCents ?? 0);
      setTotalCents(body.totalCents ?? 0);
    } catch {
      if (current()) setError("Could not start this payment. Check its status before retrying.");
    } finally {
      if (current()) { setLoading(false); inFlight.current = null; }
    }
  }, [invoiceId, method]);

  useEffect(() => {
    requestEpoch.current++;
    inFlight.current = null;
    setClientSecret(null);
    setPlatformFeeCents(0);
    setProcessingFeeCents(0);
    setTotalCents(0);
    setMethod("card");
    setLoading(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  const netToVendorCents = invoice ? Math.max(0, invoice.totalCents - platformFeeCents) : 0;
  // Derived from the server's own response (never re-read from an env var
  // client-side, which would be `undefined` in the browser bundle) — 0 until
  // the checkout starts, then the real bps this specific payment charged.

  return (
    <Modal
      open={Boolean(invoice)}
      title={invoice?.invoiceNumber ? `Pay invoice ${invoice.invoiceNumber}` : "Pay invoice"}
      onClose={() => { requestEpoch.current++; inFlight.current = null; onClose(); }}
      assistantStrip={false}
      contextPanel={<PopupRecordPreview rows={[{ label: "Vendor", value: invoice?.vendorName }, { label: "Invoice", value: invoice?.invoiceNumber }]} />}
      previewLabel="Payment preview"
      preview={invoice ? <PopupRecordPreview rows={[{ label: "Invoice amount", value: formatMoney(invoice.totalCents) }, ...(invoice.lineItems ?? []).map((line, index) => ({ label: `${index + 1}. ${line.description || "Line item"}`, value: formatMoney(line.amountCents) }))]} /> : undefined}
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
            {clientSecret ? <dl className="mt-2 space-y-1 border-t border-border/70 pt-2 text-sm" data-attr="vendor-invoice-pay-fee-disclosure">
              <div className="flex justify-between"><dt>Processing fee</dt><dd>{formatMoney(processingFeeCents)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>You pay</dt><dd>{formatMoney(totalCents)}</dd></div>
              {platformFeeCents > 0 ? <div className="flex justify-between"><dt>PropLane fee from vendor</dt><dd>{formatMoney(platformFeeCents)}</dd></div> : null}
              <div className="flex justify-between"><dt>Vendor receives</dt><dd>{formatMoney(netToVendorCents)}</dd></div>
            </dl> : null}
          </div>

          {!clientSecret ? <FieldSingleSelect label="Pay with" value={method} disabled={loading} onChange={(value) => setMethod(value as "card" | "ach")} options={[{ value: "card", label: "Card" }, { value: "ach", label: "Bank account" }]} /> : null}
          {!clientSecret ? <Button type="button" variant="primary" disabled={loading} onClick={() => start()} data-attr="vendor-invoice-pay-start">{loading ? "Preparing…" : "Continue to payment"}</Button> : null}
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
