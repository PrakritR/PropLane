"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RentalApplicationFinishPanel } from "@/components/marketing/rental-application-finish-panel";

type VerificationResult = {
  sessionId: string;
  attempt: number;
} & (
  | { kind: "submitted"; axisId: string; emailSent: boolean }
  | { kind: "retry"; error: string }
);

/** Verify a Checkout return without mounting an application draft or its writes. */
export function ApplicationFeeReturnPanel({ sessionId }: { sessionId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<VerificationResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/stripe/application-fee-verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          paid?: boolean;
          processing?: boolean;
          processingReason?: "bank_clearing" | "recipient_routing";
          error?: string;
          applicationPromoted?: boolean;
          applicationAxisId?: string | null;
          applicationSetupEmailSent?: boolean;
        };
        if (!active) return;
        const axisId = typeof data.applicationAxisId === "string" ? data.applicationAxisId.trim() : "";
        if (response.ok && data.paid === true && data.applicationPromoted === true && axisId) {
          setResult({ sessionId, attempt, kind: "submitted", axisId, emailSent: data.applicationSetupEmailSent === true });
          return;
        }
        const error = data.processing === true
          ? data.processingReason === "recipient_routing"
            ? "Payment was captured. Manager payout routing is still processing. Retry verification shortly."
            : "Your bank transfer is still processing. Retry verification after it clears."
          : data.paid === true
            ? "Payment succeeded, but your saved application could not be submitted. Retry verification or contact the manager with your payment receipt."
            : typeof data.error === "string" && data.error.trim()
              ? data.error
              : "Could not confirm payment. Retry verification.";
        setResult({ sessionId, attempt, kind: "retry", error });
      } catch {
        if (active) setResult({ sessionId, attempt, kind: "retry", error: "Could not verify payment. Check your connection and retry verification." });
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sessionId, attempt]);

  const current = result?.sessionId === sessionId && result.attempt === attempt ? result : null;
  if (current?.kind === "submitted") {
    return <RentalApplicationFinishPanel axisId={current.axisId} email="" guestFlow emailSent={current.emailSent} onDone={() => {}} />;
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <h1 className="text-lg font-bold text-foreground">Payment confirmation</h1>
      {current?.kind === "retry" ? (
        <>
          <p role="alert" className="mt-4 text-danger">{current.error}</p>
          <Button className="mt-4" data-attr="application-fee-retry-verification" onClick={() => setAttempt((previous) => previous + 1)}>Retry verification</Button>
        </>
      ) : <p role="status" className="mt-4">Verifying payment…</p>}
    </div>
  );
}
