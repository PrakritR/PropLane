"use client";

import { useCallback, useState } from "react";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { Button } from "@/components/ui/button";
import { paymentFailureCopy } from "@/lib/payments/payment-error-copy";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Lease signing fee, paid from the resident's own lease page.
 *
 * The resident signs first and pays after (PLAN-0924-1421), so this card is the
 * remaining step on a lease that is otherwise done from their side. The card
 * form renders inline; Stripe returns to `/resident/lease?…&signing_fee=return`,
 * which the panel verifies server-side before treating the fee as paid.
 */
export function ResidentLeaseSigningFeeCard({
  leaseId,
  managerUserId,
  propertyId,
  feeCents,
  alreadySigned,
}: {
  leaseId: string;
  managerUserId: string;
  propertyId: string | null;
  feeCents: number;
  /** Drives the copy only — signing is never blocked on payment. */
  alreadySigned: boolean;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(true);
  const [loading, setLoading] = useState(false);

  const start = useCallback(async () => {
    if (loading || clientSecret) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/lease-signing-fee-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leaseId, managerUserId, propertyId: propertyId ?? undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        clientSecret?: string;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.clientSecret) {
        const copy = paymentFailureCopy({ code: data.code, status: res.status, serverMessage: data.error });
        setError(copy.message);
        setCanRetry(copy.canRetry);
        return;
      }
      setClientSecret(data.clientSecret);
    } catch {
      setError("We couldn't start the payment. Nothing has been charged.");
      setCanRetry(true);
    } finally {
      setLoading(false);
    }
  }, [clientSecret, leaseId, loading, managerUserId, propertyId]);

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4" data-attr="resident-lease-signing-fee">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[12rem] flex-1">
          <p className="text-sm font-semibold text-foreground">
            Lease signing fee · {dollars(feeCents)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {alreadySigned
              ? "Your signature is recorded. Pay this fee to complete your lease."
              : "Due once your signature is recorded."}
          </p>
        </div>
        {!clientSecret ? (
          <Button
            type="button"
            variant="primary"
            className="h-9 min-h-0 shrink-0 rounded-full px-4 text-[13px]"
            data-attr="resident-lease-signing-fee-pay"
            onClick={() => start()}
          >
            {loading ? "Opening…" : `Pay ${dollars(feeCents)}`}
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium text-red-600">{error}</p>
          {canRetry ? (
            <Button type="button" variant="outline" className="px-4 text-[13px]" onClick={() => start()}>
              Try again
            </Button>
          ) : (
            <p className="text-xs text-muted">
              This isn&apos;t something you can fix — contact your property manager to finish your lease.
            </p>
          )}
        </div>
      ) : null}
      {clientSecret ? (
        <div className="mt-3">
          <StripeEmbeddedCheckout clientSecret={clientSecret} />
        </div>
      ) : null}
    </div>
  );
}
