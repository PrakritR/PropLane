"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { Button } from "@/components/ui/button";
import { isElementOnScreen } from "@/lib/dom-visibility";
import { paymentFailureCopy } from "@/lib/payments/payment-error-copy";

export type ApplicationFeeItemizationView = {
  applicationFeeCents: number;
  serviceFeeCents: number;
  totalCents: number;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Inline (embedded) application-fee payment — the card form renders INSIDE the
 * application step; the applicant never leaves the wizard for a hosted Stripe
 * page (captain requirement). It POSTs to `/api/stripe/application-fee-checkout`
 * with `mode: "embedded"` to mint a client secret, shows the itemized total,
 * and renders Stripe's embedded form. On success Stripe returns the applicant
 * to `returnPath?fee_checkout=return&session_id=…`, which the wizard verifies
 * server-side before treating the fee as paid.
 *
 * A failed or unconfigured session shows a clear error with Retry and leaves the
 * caller on the step — this component never navigates away or clears answers.
 */
export function ApplicationFeeInlinePayment({
  propertyId,
  residentEmail,
  residentName,
  managerUserId,
  rentalType,
  returnPath,
  onItemization,
}: {
  propertyId: string;
  residentEmail: string;
  residentName?: string;
  managerUserId: string;
  rentalType?: "standard" | "short_term";
  /** App path Stripe returns to after payment (must start with "/"). */
  returnPath: string;
  onItemization?: (view: ApplicationFeeItemizationView) => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [itemization, setItemization] = useState<ApplicationFeeItemizationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A missing server key or an unfinished manager setup cannot be retried away.
  const [canRetry, setCanRetry] = useState(true);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const start = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/application-fee-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          residentEmail,
          residentName,
          managerUserId,
          rentalType: rentalType === "short_term" ? "short_term" : undefined,
          mode: "embedded",
          returnPath,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        clientSecret?: string;
        applicationFeeCents?: number;
        serviceFeeCents?: number;
        totalCents?: number;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.clientSecret) {
        // `data.error` used to render verbatim, so an applicant at the moment
        // of paying was shown "Stripe is not configured on the server (missing
        // STRIPE_SECRET_KEY)" — an internal fact, next to a Try again button
        // that could not help because the key would still be missing.
        const copy = paymentFailureCopy({ code: data.code, status: res.status, serverMessage: data.error });
        setError(copy.message);
        setCanRetry(copy.canRetry);
        return;
      }
      const view: ApplicationFeeItemizationView = {
        applicationFeeCents: data.applicationFeeCents ?? 0,
        serviceFeeCents: data.serviceFeeCents ?? 0,
        totalCents: data.totalCents ?? data.applicationFeeCents ?? 0,
      };
      setItemization(view);
      onItemization?.(view);
      setClientSecret(data.clientSecret);
    } catch {
      setError("We couldn't start the payment. Nothing has been charged.");
      setCanRetry(true);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [propertyId, residentEmail, residentName, managerUserId, rentalType, returnPath, onItemization]);

  // The wizard is embedded in dual-mount (mobile-card + desktop-table) lists,
  // so TWO live copies of this component can exist with CSS deciding which is
  // visible. Only the ON-SCREEN copy may mint a Stripe Checkout session — the
  // hidden duplicate would otherwise create an abandoned session (and a second
  // embedded iframe) on every mount. The interval covers a copy that becomes
  // visible later (e.g. the viewport crossing the `lg` breakpoint).
  useEffect(() => {
    if (isElementOnScreen(rootRef.current)) {
      void start();
      return;
    }
    const timer = window.setInterval(() => {
      if (!isElementOnScreen(rootRef.current)) return;
      window.clearInterval(timer);
      void start();
    }, 500);
    return () => window.clearInterval(timer);
  }, [start]);

  if (error) {
    return (
      <div ref={rootRef} className="space-y-3 rounded-2xl border border-border bg-card p-4" data-attr="application-fee-inline-error">
        <p className="text-sm font-medium text-red-600">{error}</p>
        {canRetry ? (
          <Button type="button" variant="outline" className="px-4 text-[13px]" onClick={() => start()}>
            Try again
          </Button>
        ) : (
          // Offering a retry that cannot work is worse than offering none: it
          // reads as "you did something wrong" for a server-side blocker.
          <p className="text-xs text-muted">
            This isn&apos;t something you can fix — contact the property manager to finish your
            application.
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="space-y-4">
      {itemization ? (
        <dl className="space-y-1 rounded-2xl border border-border bg-card p-4 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted">Application fee</dt>
            <dd className="tabular-nums">{dollars(itemization.applicationFeeCents)}</dd>
          </div>
          {itemization.serviceFeeCents > 0 ? (
            <div className="flex items-center justify-between">
              <dt className="text-muted">Processing fee</dt>
              <dd className="tabular-nums">{dollars(itemization.serviceFeeCents)}</dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between border-t border-border pt-1 font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{dollars(itemization.totalCents)}</dd>
          </div>
        </dl>
      ) : null}
      {loading && !clientSecret ? (
        <div className="flex min-h-[120px] items-center justify-center rounded-2xl border border-border bg-card text-sm text-muted">
          Preparing secure payment…
        </div>
      ) : null}
      {clientSecret ? <StripeEmbeddedCheckout clientSecret={clientSecret} /> : null}
    </div>
  );
}
