"use client";

import { useEffect, useState } from "react";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { Button } from "@/components/ui/button";
import type { CheckrAddOnSlug } from "@/lib/checkr/packages";
import type { CheckrPackage } from "@/lib/checkr/config";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";

/**
 * Inline Stripe payment for applicant screening — card form renders inside the
 * screening modal below the package total. On completion Stripe returns to
 * `returnPath?screening=return&session_id=…`; the parent verifies server-side
 * and closes the modal on the background-check tab.
 */
export function ScreeningInlinePayment({
  applicationId,
  packageSlug,
  addOnProducts,
  returnPath,
  onPaid,
  onError,
}: {
  applicationId: string;
  packageSlug: CheckrPackage;
  addOnProducts: CheckrAddOnSlug[];
  /** App path Stripe returns to after payment (must start with "/"). */
  returnPath: string;
  onPaid: (backgroundCheck: ApplicationBackgroundCheck) => void;
  onError?: (message: string) => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const addOnKey = addOnProducts.join(",");

  useEffect(() => {
    let cancelled = false;
    setClientSecret(null);
    setError(null);
    setLoading(true);

    void (async () => {
      try {
        const res = await fetch("/api/screening/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            applicationId,
            packageSlug,
            addOnProducts,
            mode: "embedded",
            returnPath,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          clientSecret?: string;
          ran?: boolean;
          backgroundCheck?: ApplicationBackgroundCheck;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          const message = data.error ?? "Could not start payment. Please try again.";
          setError(message);
          onError?.(message);
          return;
        }
        if (data.ran && data.backgroundCheck) {
          onPaid(data.backgroundCheck);
          return;
        }
        if (!data.clientSecret) {
          const message = "Stripe did not return a payment form.";
          setError(message);
          onError?.(message);
          return;
        }
        setClientSecret(data.clientSecret);
      } catch {
        if (cancelled) return;
        const message = "Could not start payment. Please try again.";
        setError(message);
        onError?.(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applicationId, packageSlug, addOnKey, returnPath, onPaid, onError]);

  const retry = () => {
    setError(null);
    setLoading(true);
    setClientSecret(null);
    void fetch("/api/screening/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        applicationId,
        packageSlug,
        addOnProducts,
        mode: "embedded",
        returnPath,
      }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          clientSecret?: string;
          error?: string;
        };
        if (!res.ok || !data.clientSecret) {
          setError(data.error ?? "Could not start payment. Please try again.");
          return;
        }
        setClientSecret(data.clientSecret);
      })
      .catch(() => setError("Could not start payment. Please try again."))
      .finally(() => setLoading(false));
  };

  if (error) {
    return (
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4" data-attr="screening-inline-error">
        <p className="text-sm font-medium text-red-600">{error}</p>
        <Button type="button" variant="outline" className="px-4 text-[13px]" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-attr="screening-inline-payment">
      {loading && !clientSecret ? (
        <div className="flex min-h-[120px] items-center justify-center rounded-2xl border border-border bg-card text-sm text-muted">
          Preparing secure payment…
        </div>
      ) : null}
      {clientSecret ? (
        <StripeEmbeddedCheckout
          clientSecret={clientSecret}
          className="min-h-[320px] overflow-hidden rounded-2xl border border-border bg-card"
        />
      ) : null}
    </div>
  );
}
