"use client";

import { useMemo, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { AdminBillingActionDialog } from "@/components/portal/admin-billing-action-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { formatPacificDate } from "@/lib/pacific-time";
import type { AdminAccountBilling } from "@/lib/admin/admin-account-billing.server";

/**
 * Staff money actions on a manager's Subscription card (Oct 28): Change price, Refund, Cancel and
 * End promo. Four icons crowd the card header past a phone's width (the red Cancel clipped at 390px),
 * so they live behind ONE ⋯ in the header at every width, each opening the same reason popup as every
 * other billing change. The server is the authority on every limit (the refundable amount is
 * re-read from Stripe there); the popups only keep an obviously wrong value from being sent.
 */

type MoneyDialog = "price" | "refund" | "cancel" | "endpromo" | null;

const REFUND_INVOICE_LIMIT = 12;

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "12.50" -> 1250, or `null` for anything that is not a positive amount with at most two decimals. */
export function dollarsToCents(raw: string): number | null {
  const t = raw.trim().replace(/^\$/, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

/** What can still be refunded on an invoice: paid, less what was already refunded. */
const refundable = (p: { amountCents: number; refundedCents?: number }) => Math.max(0, p.amountCents - (p.refundedCents ?? 0));

const tomorrowIso = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function post(
  url: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<{ error: string | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: res.ok ? null : data.error || fallback };
  } catch {
    return { error: fallback };
  }
}

export function useBillingMoneyActions({
  userId,
  billing,
  onChanged,
  showToast,
}: {
  userId: string;
  billing: AdminAccountBilling | null;
  onChanged: () => void;
  showToast: (m: string) => void;
}): { icons: ReactNode; dialogs: ReactNode } {
  const [dialog, setDialog] = useState<MoneyDialog>(null);
  const [priceMode, setPriceMode] = useState<"custom" | "rate-card">("custom");
  const [priceDraft, setPriceDraft] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [refundDraft, setRefundDraft] = useState("");
  const [nonce, setNonce] = useState("");
  const [cancelWhen, setCancelWhen] = useState<"period_end" | "now">("period_end");
  const [promoWhen, setPromoWhen] = useState<"now" | "date">("now");
  const [promoDate, setPromoDate] = useState("");

  const hasSubscription = billing?.stripe.subscriptionLinked ?? false;
  // End promo writes `promo_ends_at` on a purchase row that carries a waiver code, so the item exists
  // only when there is such a code. A Stripe-side promotion code (`plan.promoCode`) is not endable
  // here and the route would refuse it with a 409.
  const waiverPromoCode = billing?.plan.waiverPromoCode ?? null;
  const base = `/api/admin/accounts/${encodeURIComponent(userId)}/billing`;

  const invoices = useMemo(
    () => (billing?.payments ?? []).filter((p) => p.subscriptionInvoice && refundable(p) > 0).slice(0, REFUND_INVOICE_LIMIT),
    [billing],
  );
  const invoice = invoices.find((p) => p.id === invoiceId) ?? null;

  const done = (message: string) => {
    showToast(message);
    onChanged();
    return null;
  };

  const openPrice = () => {
    setPriceMode("custom");
    setPriceDraft(billing?.plan.monthlyCents ? (billing.plan.monthlyCents / 100).toFixed(2) : "");
    setDialog("price");
  };
  const openRefund = () => {
    const first = invoices[0];
    setInvoiceId(first?.id ?? "");
    setRefundDraft(first ? (refundable(first) / 100).toFixed(2) : "");
    setNonce(crypto.randomUUID());
    setDialog("refund");
  };
  const openCancel = () => {
    setCancelWhen("period_end");
    setDialog("cancel");
  };
  const openEndPromo = () => {
    setPromoWhen("now");
    setPromoDate("");
    setDialog("endpromo");
  };

  const priceCents = dollarsToCents(priceDraft);
  const refundCents = dollarsToCents(refundDraft);

  const submitPrice = async (reason: string) => {
    const r = await post(
      `${base}/price`,
      { monthlyCents: priceMode === "rate-card" ? "rate-card" : priceCents, reason },
      "Could not change the price.",
    );
    if (r.error) return r.error;
    return done(priceMode === "rate-card" ? "Back on the rate card from the next invoice." : `Price set to ${money(priceCents ?? 0)} a month from the next invoice.`);
  };
  const submitRefund = async (reason: string) => {
    const r = await post(
      `${base}/refund`,
      { invoiceId, amountCents: refundCents, nonce, reason },
      "Could not refund that invoice.",
    );
    if (r.error) return r.error;
    return done(`Refunded ${money(refundCents ?? 0)}.`);
  };
  const submitCancel = async (reason: string) => {
    const r = await post(`${base}/cancel`, { when: cancelWhen, reason }, "Could not cancel the subscription.");
    if (r.error) return r.error;
    return done(cancelWhen === "now" ? "Subscription canceled." : "Subscription will end at the close of the period.");
  };
  const submitEndPromo = async (reason: string) => {
    const endsAt = promoWhen === "now" ? "now" : promoDate;
    const r = await post(`${base}/end-promo`, { endsAt, reason }, "Could not end the promo.");
    if (r.error) return r.error;
    return done(promoWhen === "now" ? "Promo ended." : `Promo ends ${formatPacificDate(`${promoDate}T12:00:00.000Z`, { year: "numeric", month: "short", day: "numeric" })}.`);
  };

  const icons = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PortalIconAction icon={MoreHorizontal} label="More billing actions" data-attr="admin-billing-more" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" rowSheet>
        <DropdownMenuItem disabled={!hasSubscription} data-attr="admin-billing-change-price" onSelect={openPrice}>
          Change price
        </DropdownMenuItem>
        <DropdownMenuItem disabled={invoices.length === 0} data-attr="admin-billing-refund" onSelect={openRefund}>
          Refund
        </DropdownMenuItem>
        {waiverPromoCode ? (
          <DropdownMenuItem data-attr="admin-billing-end-promo" onSelect={openEndPromo}>
            End promo
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-700 focus:text-red-700"
          disabled={!hasSubscription}
          data-attr="admin-billing-cancel"
          onSelect={openCancel}
        >
          Cancel subscription
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const dialogs = (
    <>
      <AdminBillingActionDialog
        open={dialog === "price"}
        title="Change price"
        submitLabel={priceMode === "rate-card" ? "Use rate card" : "Change price"}
        dataAttr="admin-billing-price-dialog"
        canSubmit={priceMode === "rate-card" || priceCents !== null}
        onClose={() => setDialog(null)}
        onSubmit={submitPrice}
      >
        <FieldSingleSelect
          label="Price"
          value={priceMode}
          options={[
            { value: "custom", label: "Custom monthly amount" },
            { value: "rate-card", label: "Rate card" },
          ]}
          onChange={(next) => setPriceMode(next === "rate-card" ? "rate-card" : "custom")}
          dataAttr="admin-billing-price-mode"
        />
        {priceMode === "custom" ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-foreground" htmlFor="admin-billing-price-amount">
              Monthly price
            </label>
            <Input
              id="admin-billing-price-amount"
              value={priceDraft}
              inputMode="decimal"
              maxLength={10}
              autoComplete="off"
              onChange={(e) => setPriceDraft(e.target.value.replace(/[^\d.$]/g, ""))}
              data-attr="admin-billing-price-amount"
            />
          </div>
        ) : null}
        <RecordFactRow label="Starts" value="Next invoice" />
      </AdminBillingActionDialog>

      <AdminBillingActionDialog
        open={dialog === "refund"}
        title="Refund"
        submitLabel={refundCents ? `Refund ${money(refundCents)}` : "Refund"}
        dataAttr="admin-billing-refund-dialog"
        canSubmit={Boolean(invoice) && refundCents !== null && refundCents <= (invoice ? refundable(invoice) : 0)}
        onClose={() => setDialog(null)}
        onSubmit={submitRefund}
      >
        <FieldSingleSelect
          label="Invoice"
          value={invoiceId}
          options={invoices.map((p) => ({
            value: p.id,
            label: `${formatPacificDate(p.at ?? "", { month: "short", day: "numeric", year: "numeric" })} · ${money(refundable(p))}${p.number ? ` · ${p.number}` : ""}`,
          }))}
          onChange={(next) => {
            setInvoiceId(next);
            const picked = invoices.find((p) => p.id === next);
            if (picked) setRefundDraft((refundable(picked) / 100).toFixed(2));
          }}
          dataAttr="admin-billing-refund-invoice"
        />
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-foreground" htmlFor="admin-billing-refund-amount">
            Amount
          </label>
          <Input
            id="admin-billing-refund-amount"
            value={refundDraft}
            inputMode="decimal"
            maxLength={10}
            autoComplete="off"
            onChange={(e) => setRefundDraft(e.target.value.replace(/[^\d.$]/g, ""))}
            data-attr="admin-billing-refund-amount"
          />
        </div>
      </AdminBillingActionDialog>

      <AdminBillingActionDialog
        open={dialog === "cancel"}
        title="Cancel subscription"
        submitLabel={cancelWhen === "now" ? "Cancel now" : "Cancel at period end"}
        dataAttr="admin-billing-cancel-dialog"
        onClose={() => setDialog(null)}
        onSubmit={submitCancel}
      >
        <FieldSingleSelect
          label="When"
          value={cancelWhen}
          options={[
            { value: "period_end", label: "End of period" },
            { value: "now", label: "Now" },
          ]}
          onChange={(next) => setCancelWhen(next === "now" ? "now" : "period_end")}
          dataAttr="admin-billing-cancel-when"
        />
      </AdminBillingActionDialog>

      <AdminBillingActionDialog
        open={dialog === "endpromo"}
        title="End promo"
        submitLabel="End promo"
        dataAttr="admin-billing-end-promo-dialog"
        canSubmit={promoWhen === "now" || (Boolean(promoDate) && promoDate >= tomorrowIso())}
        onClose={() => setDialog(null)}
        onSubmit={submitEndPromo}
      >
        <FieldSingleSelect
          label="When"
          value={promoWhen}
          options={[
            { value: "now", label: "Now" },
            { value: "date", label: "On a date" },
          ]}
          onChange={(next) => setPromoWhen(next === "date" ? "date" : "now")}
          dataAttr="admin-billing-end-promo-when"
        />
        {promoWhen === "date" ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-foreground" htmlFor="admin-billing-end-promo-date">
              Ends
            </label>
            <DateField id="admin-billing-end-promo-date" value={promoDate} min={tomorrowIso()} onChange={setPromoDate} />
          </div>
        ) : null}
      </AdminBillingActionDialog>
    </>
  );

  return { icons, dialogs };
}
