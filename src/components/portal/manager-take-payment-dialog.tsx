"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";

export function ManagerTakePaymentDialog({ chargeId, onClose, onSubmitted }: { chargeId: string; onClose: () => void; onSubmitted: () => void }) {
  const [method, setMethod] = useState("card");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setError(null);
    try {
      const response = await fetch("/api/portal/take-payment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chargeId, paymentMethod: method }) });
      const result = await response.json() as { clientSecret?: string; error?: string };
      if (!response.ok || !result.clientSecret) { setError(result.error ?? "Could not start payment."); return; }
      setSecret(result.clientSecret);
    } catch { setError("Could not start payment."); }
  }
  return <PortalDialog open title="Take payment" onClose={onClose} primaryAction={secret ? null : { label: "Continue to payment", onClick: start }}>
    {secret ? <StripeEmbeddedCheckout clientSecret={secret} onComplete={onSubmitted} /> : <FieldSingleSelect label="Method" value={method} onChange={setMethod} options={[{ value: "card", label: "Card" }, { value: "ach", label: "Bank transfer" }]} />}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
  </PortalDialog>;
}
