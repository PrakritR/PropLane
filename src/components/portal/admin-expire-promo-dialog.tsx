"use client";

import { useEffect, useState } from "react";
import { AdminBillingActionDialog } from "@/components/portal/admin-billing-action-dialog";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DateField } from "@/components/ui/date-field";
import type { AdminPromoCode } from "@/lib/admin/admin-promo-codes.server";

const WHEN_OPTIONS = [
  { value: "now", label: "Now" },
  { value: "date", label: "On a date" },
];

/** `YYYY-MM-DD` of today (UTC): the earliest date the server accepts (the code stops at the end of that day). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function consequenceLine(code: AdminPromoCode): string | null {
  if (code.kind === "stripe_promo_code") return null;
  const n = code.accounts;
  if (n === 0) return "No account is on this code.";
  return `${n} ${n === 1 ? "account drops" : "accounts drop"} to Free and must choose a plan.`;
}

/**
 * Expire a promo code (Money > Promo codes). When = Now | a date, a REQUIRED reason, and "Expire code".
 * A payment-waiver code stops redeeming and every grant made with it drops to Free; a Stripe code is turned
 * off now and, when ticked, its discount comes off each subscriber's next invoice. The server writes the audit
 * row first and refuses without a reason.
 */
export function AdminExpirePromoDialog({
  code,
  onClose,
  onExpired,
}: {
  code: AdminPromoCode | null;
  onClose: () => void;
  onExpired: (message: string) => void;
}) {
  const [when, setWhen] = useState("now");
  const [date, setDate] = useState("");
  const [endDiscounts, setEndDiscounts] = useState(false);
  const stripeCode = code?.kind === "stripe_promo_code";

  useEffect(() => {
    if (!code) return;
    queueMicrotask(() => {
      setWhen("now");
      setDate("");
      setEndDiscounts(false);
    });
  }, [code]);

  if (!code) return null;
  const consequence = consequenceLine(code);

  const submit = async (reason: string): Promise<string | null> => {
    const res = await fetch("/api/admin/promo-codes", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verb: "expire",
        code: code.code,
        ...(stripeCode ? { id: code.id } : {}),
        expiresAt: when === "date" ? date : "now",
        reason,
        ...(stripeCode ? { endStripeDiscounts: endDiscounts } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return json.error ?? "Could not expire the code.";
    onExpired(when === "date" ? `${code.code} will expire.` : `${code.code} expired.`);
    return null;
  };

  return (
    <AdminBillingActionDialog
      open
      title={`Expire ${code.code}`}
      submitLabel="Expire code"
      dataAttr="admin-promo-expire-dialog"
      canSubmit={when === "now" || Boolean(date && date >= todayIso())}
      onClose={onClose}
      onSubmit={submit}
    >
      {stripeCode ? null : (
        <>
          <FieldSingleSelect label="When" value={when} options={WHEN_OPTIONS} onChange={setWhen} dataAttr="admin-promo-expire-when" />
          {when === "date" ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium text-foreground" htmlFor="admin-promo-expire-date">
                Date
              </label>
              <DateField id="admin-promo-expire-date" value={date} min={todayIso()} onChange={setDate} />
            </div>
          ) : null}
        </>
      )}
      {stripeCode ? (
        <label className="flex items-center gap-2 text-[13px] text-foreground">
          <input
            type="checkbox"
            checked={endDiscounts}
            onChange={(e) => setEndDiscounts(e.target.checked)}
            data-attr="admin-promo-expire-end-discounts"
          />
          End the discount on subscribers&apos; next invoice
        </label>
      ) : null}
      {consequence ? (
        <p className="text-[13px] font-medium text-foreground" data-attr="admin-promo-expire-count">
          {consequence}
        </p>
      ) : null}
    </AdminBillingActionDialog>
  );
}
