"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { selectVendorInvoicesWithinBalance, vendorInvoiceShortfallCents } from "@/lib/vendor-invoice-bulk-pay";
import {
  VendorInvoiceManagerPaySheet,
  type VendorInvoicePayLineItem,
  type VendorInvoicePayTarget,
} from "@/components/portal/vendor-invoice-manager-pay-sheet";

type PayVendorsInvoiceRow = {
  id: string;
  vendorName: string;
  invoiceNumber: string | null;
  totalCents: number;
  memo: string | null;
  lineItems: VendorInvoicePayLineItem[];
};

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * C260 (U043): "Pay vendors" — every approved-or-scheduled invoice billed to
 * this manager, each with its own "Pay from balance", plus a "Pay all
 * approved" bulk action once more than one is outstanding. Every pay click —
 * single or bulk — goes through the SAME existing, already-reviewed
 * `POST /api/vendor/invoices/[id]/pay-from-balance` route, once per invoice,
 * server-authorized each time; this component never invents a batch endpoint
 * or a new payment rail. C106 ("Pay from balance" on an approved invoice) is
 * the same button — see the per-row shortfall message below for why an
 * ACH/card fallback is NOT added here (docs/agents/vendor-invoicing.md: the
 * only card-funded rail in the codebase runs through a different table,
 * `portal_work_order_records`/`vendor_payouts`, and never marks a
 * `vendor_invoices` row paid, so routing a shortfall there would desync the
 * two — the brief's "don't invent a payment rail" applies here instead).
 *
 * Rendered by the caller once EITHER `WORKSPACE_CONNECT_ENABLED` + the
 * PropLane balance are both on (`balanceEligible`) OR `VENDOR_BANKING_ENABLED`
 * is on — the manager needs an in-app way to pay an approved vendor invoice
 * under either feature. `balancePayEnabled` (default true, matching every
 * existing caller) governs only the balance-funded actions — the per-row
 * "Pay from balance" button, its shortfall message, and the bulk "Pay all
 * approved" — so a vendor-banking-only manager (balance/connect flags off)
 * still sees every approved invoice with its "Pay" (embedded Stripe
 * checkout) action, never a balance action it cannot actually use.
 */
export function PayVendorsCard({
  availableCents,
  balancePayEnabled = true,
}: {
  availableCents: number;
  balancePayEnabled?: boolean;
}) {
  const { showToast } = useAppUi();
  const [invoices, setInvoices] = useState<PayVendorsInvoiceRow[] | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [bulkPaying, setBulkPaying] = useState(false);
  const [payTarget, setPayTarget] = useState<VendorInvoicePayTarget | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/manager/vendor-invoices?status=approved,scheduled", { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as {
        invoices?: Array<{
          id: string;
          vendorName?: string;
          invoiceNumber: string | null;
          totalCents: number;
          memo?: string | null;
          lineItems?: VendorInvoicePayLineItem[];
        }>;
      };
      if (!res.ok) return;
      setInvoices(
        (body.invoices ?? []).map((row) => ({
          id: row.id,
          vendorName: row.vendorName?.trim() || "Vendor",
          invoiceNumber: row.invoiceNumber,
          totalCents: row.totalCents,
          memo: row.memo ?? null,
          lineItems: row.lineItems ?? [],
        })),
      );
    } catch {
      // Silent — the card simply stays empty/loading if the read fails; it is
      // additive and never blocks the rest of Finances Overview.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Stripe's embedded-checkout `return_url` (vendor-invoice-pay.server.ts)
  // lands back here with `?invoice_pay=success` after the manager pays — the
  // webhook (not this read) is what actually marks the invoice paid, so this
  // is a courtesy toast + refresh, never the source of truth.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("invoice_pay");
    if (!result) return;
    if (result === "success") {
      showToast("Payment sent.");
      void load();
    }
    params.delete("invoice_pay");
    params.delete("session_id");
    const next = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
    // Runs once on mount only — this reads the URL Stripe's redirect left behind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payOne = useCallback(
    async (id: string): Promise<{ ok: true } | { ok: false; error: string; insufficientBalance?: boolean }> => {
      try {
        const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(id)}/pay-from-balance`, {
          method: "POST",
          credentials: "include",
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (!res.ok) {
          return { ok: false, error: body.error ?? "Could not pay this invoice.", insufficientBalance: body.code === "insufficient_balance" };
        }
        // The server already fires `vendor_invoice_paid_from_balance` on the
        // confirmed write (pay-from-balance/route.ts) — no client-side re-fire.
        return { ok: true };
      } catch {
        return { ok: false, error: "Could not pay this invoice." };
      }
    },
    [],
  );

  const handlePayOne = useCallback(
    async (id: string) => {
      setPayingId(id);
      const result = await payOne(id);
      setPayingId(null);
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      showToast("Paid from your PropLane balance.");
      void load();
    },
    [load, payOne, showToast],
  );

  const handlePayAllApproved = useCallback(async () => {
    if (!invoices || invoices.length === 0) return;
    const payableIds = selectVendorInvoicesWithinBalance(
      invoices.map((invoice) => ({ id: invoice.id, totalCents: invoice.totalCents })),
      availableCents,
    );
    if (payableIds.length === 0) {
      showToast("Nothing payable from balance right now.");
      return;
    }
    setBulkPaying(true);
    let paid = 0;
    let failed = 0;
    for (const id of payableIds) {
      // Sequential and server-authorized every time — each call re-checks the
      // real balance and invoice status, so a row a prior call already paid
      // (or that changed underneath this pass) fails cleanly instead of
      // double-charging.
      const result = await payOne(id);
      if (result.ok) paid += 1;
      else failed += 1;
    }
    setBulkPaying(false);
    if (paid > 0) {
      showToast(
        failed > 0
          ? `Paid ${paid} invoice${paid === 1 ? "" : "s"} from balance — ${failed} could not be paid.`
          : `Paid ${paid} invoice${paid === 1 ? "" : "s"} from balance.`,
      );
    } else {
      showToast("Could not pay any invoices from balance.");
    }
    void load();
  }, [availableCents, invoices, load, payOne, showToast]);

  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr="finances-pay-vendors-card">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Pay vendors</h2>
      </div>
      {invoices === null ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted" data-attr="finances-pay-vendors-loading">
          Loading…
        </p>
      ) : invoices.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted" data-attr="finances-pay-vendors-empty">
          No approved invoices waiting on payment
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border/70" data-attr="finances-pay-vendors-list">
            {invoices.map((invoice) => {
              const shortfall = vendorInvoiceShortfallCents(invoice.totalCents, availableCents);
              return (
                <li key={invoice.id} className="flex items-center justify-between gap-3 px-4 py-2.5" data-attr="finances-pay-vendors-row">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-foreground">{invoice.vendorName}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {invoice.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : "Invoice"} · {formatMoney(invoice.totalCents)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {!balancePayEnabled ? null : shortfall > 0 ? (
                      <span className="text-right text-[12px] font-medium text-[var(--status-overdue-fg)]" data-attr="finances-pay-vendors-shortfall">
                        Balance short {formatMoney(shortfall)}
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full px-3 py-1 text-[12px]"
                        onClick={() => handlePayOne(invoice.id)}
                        disabled={payingId === invoice.id || bulkPaying}
                        data-attr="finances-pay-vendors-pay-one"
                      >
                        {payingId === invoice.id ? "Paying…" : "Pay from balance"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full px-3 py-1 text-[12px]"
                      onClick={() =>
                        setPayTarget({
                          id: invoice.id,
                          vendorName: invoice.vendorName,
                          invoiceNumber: invoice.invoiceNumber,
                          totalCents: invoice.totalCents,
                          memo: invoice.memo,
                          lineItems: invoice.lineItems,
                        })
                      }
                      data-attr="finances-pay-vendors-pay-card"
                    >
                      Pay
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
          {balancePayEnabled && invoices.length > 1 ? (
            <div className="px-4 py-3">
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                onClick={handlePayAllApproved}
                disabled={bulkPaying || payingId !== null}
                data-attr="finances-pay-vendors-pay-all"
              >
                {bulkPaying ? "Paying…" : "Pay all approved"}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <VendorInvoiceManagerPaySheet
        invoice={payTarget}
        onClose={() => {
          setPayTarget(null);
          void load();
        }}
      />
    </section>
  );
}
