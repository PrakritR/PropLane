"use client";

import { useEffect, useState } from "react";
import { ReviewRow, ReviewSection } from "@/components/portal/pro-application-readonly-review";
import { formatPacificDate } from "@/lib/pacific-time";
import type { ApplicationReceipt } from "@/lib/application-payment-receipt";

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function ApplicationPaymentReceiptCard({ applicationId }: { applicationId: string }) {
  const [result, setResult] = useState<
    { applicationId: string; receipt: ApplicationReceipt } | { applicationId: string; error: true } | null
  >(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/manager-applications/${encodeURIComponent(applicationId)}/receipt`, {
      credentials: "include", signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Receipt read failed");
      const body = await response.json() as { receipt?: ApplicationReceipt };
      if (!body.receipt) throw new Error("Receipt missing");
      if (!controller.signal.aborted) setResult({ applicationId, receipt: body.receipt });
    }).catch(() => { if (!controller.signal.aborted) setResult({ applicationId, error: true }); });
    return () => controller.abort();
  }, [applicationId]);

  const currentResult = result?.applicationId === applicationId ? result : null;
  const receipt = currentResult && "receipt" in currentResult ? currentResult.receipt : null;
  const status = !currentResult ? "Loading…" : "error" in currentResult ? "Could not load payment" : ({
    paid: "Paid", processing: "Processing", partially_refunded: "Partially refunded",
    refunded: "Refunded", not_received: "Not received", needs_review: "Payment needs review",
  } as const)[currentResult.receipt.status];
  return (
    <ReviewSection title="Application payment" data-attr="application-payment-receipt">
      <ReviewRow k="Status" v={status} />
      {receipt?.principalCents !== undefined ? (
        <ReviewRow k={receipt.status === "needs_review" ? "Amount recorded" :
          receipt.status === "processing" ? "Application fee" : "Amount received"} v={money(receipt.principalCents)} />
      ) : null}
      {receipt?.refundedCents !== undefined ? <ReviewRow k="Amount refunded" v={money(receipt.refundedCents)} /> : null}
      {receipt?.paidAt ? <ReviewRow k="Paid on" v={formatPacificDate(receipt.paidAt, { month: "short", day: "numeric", year: "numeric" })} /> : null}
    </ReviewSection>
  );
}
