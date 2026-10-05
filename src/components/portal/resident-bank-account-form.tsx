"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

type BankStatus = "entry" | "verification" | "clearing" | "paid" | "review";

/** Bank numbers stay in the browser and go directly to Stripe.js. */
export function ResidentBankAccountForm({
  clientSecret,
  intentId,
  kind,
  amountCents,
  initialStatus = "entry",
  onComplete,
  onStatusChange,
}: {
  clientSecret: string;
  intentId: string;
  kind: "payment" | "setup";
  amountCents?: number;
  initialStatus?: BankStatus;
  onComplete?: () => void;
  onStatusChange?: (status: BankStatus) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  // A provider PI can say succeeded before our exact receipt/ledger settles.
  // Only the authenticated reconciliation response may render "received".
  const [status, setStatus] = useState<BankStatus | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [accountType, setAccountType] = useState("checking");
  const [verificationKind, setVerificationKind] = useState<"code" | "amounts">("code");

  const endpoint = kind === "payment" ? "/api/stripe/resident-ach-payment" : "/api/stripe/resident-bank-setup";
  const intentParam = kind === "payment" ? "payment_intent_id" : "setup_intent_id";

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`${endpoint}?${intentParam}=${encodeURIComponent(intentId)}`, {
        credentials: "include", cache: "no-store",
      });
      const result = await response.json() as { bankStatus?: BankStatus; paid?: boolean; error?: string };
      if (!response.ok || !result.bankStatus) throw new Error(result.error ?? "Bank status is unavailable.");
      if (kind === "payment" && result.bankStatus === "paid" && result.paid !== true) {
        throw new Error("Payment receipt needs review.");
      }
      setStatus(result.bankStatus);
      onStatusChangeRef.current?.(result.bankStatus);
      if (result.bankStatus === "paid") onCompleteRef.current?.();
    } catch (cause) {
      setStatus("review");
      setError(cause instanceof Error ? cause.message : "Bank status is unavailable.");
    }
  }, [endpoint, intentId, intentParam, kind]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { await loadStatus(); } finally { setBusy(false); }
  }, [loadStatus]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  async function confirmBankAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consent || !formRef.current) return;
    if (kind === "payment" && (!Number.isSafeInteger(amountCents) || (amountCents ?? 0) <= 0)) {
      setError("Payment amount needs review.");
      return;
    }
    const data = new FormData(formRef.current);
    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const routing = String(data.get("routing") ?? "").trim();
    const account = String(data.get("account") ?? "").trim();
    if (!name || !email.includes("@") || !/^\d{9}$/.test(routing) || !/^\d{4,17}$/.test(account)) {
      setError("Enter your name, email, 9-digit routing number, and account number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const stripe = await stripePromise;
      if (!stripe) throw new Error("Secure bank entry is unavailable.");
      const details = {
        payment_method: {
          billing_details: { name, email },
          us_bank_account: {
            account_number: account,
            routing_number: routing,
            account_holder_type: "individual",
            account_type: accountType,
          },
        },
      };
      const result = kind === "payment"
        ? await stripe.confirmUsBankAccountPayment(clientSecret, details)
        : await stripe.confirmUsBankAccountSetup(clientSecret, details);
      formRef.current?.reset();
      if (result.error) throw new Error(result.error.message ?? "Bank account could not be confirmed.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bank account could not be confirmed.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyDeposits(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const descriptorCode = String(data.get("descriptorCode") ?? "").trim().toUpperCase();
    const first = Number(data.get("firstAmount"));
    const second = Number(data.get("secondAmount"));
    const body = verificationKind === "code"
      ? { descriptorCode }
      : { amounts: [first, second] };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [kind === "payment" ? "paymentIntentId" : "setupIntentId"]: intentId, ...body }),
      });
      const result = await response.json() as { bankStatus?: BankStatus; paid?: boolean; error?: string };
      if (!response.ok || !result.bankStatus) throw new Error(result.error ?? "Bank verification failed.");
      if (kind === "payment" && result.bankStatus === "paid" && result.paid !== true) {
        throw new Error("Payment receipt needs review.");
      }
      setStatus(result.bankStatus);
      onStatusChangeRef.current?.(result.bankStatus);
      if (result.bankStatus === "paid") onCompleteRef.current?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bank verification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-attr="resident-bank-account-form">
      {status === "loading" ? <p className="text-sm font-medium">
        {initialStatus === "paid" ? "Confirming receipt…" : "Loading bank status…"}
      </p> : null}
      {status === "entry" ? (
        <form ref={formRef} onSubmit={confirmBankAccount} className="space-y-3 ph-no-capture ph-no-record">
          <label className="block text-sm font-medium">Account holder name<Input name="name" autoComplete="name" required /></label>
          <label className="block text-sm font-medium">Email<Input name="email" type="email" autoComplete="email" required /></label>
          <label className="block text-sm font-medium">Routing number<Input name="routing" inputMode="numeric" autoComplete="off" maxLength={9} required /></label>
          <label className="block text-sm font-medium">Account number<Input name="account" inputMode="numeric" type="password" autoComplete="off" required /></label>
          <FieldSingleSelect label="Account type" value={accountType} onChange={setAccountType}
            options={[{ value: "checking", label: "Checking" }, { value: "savings", label: "Savings" }]} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required />
            <span>{kind === "payment"
              ? `I authorize PropLane to debit this bank account once for $${((amountCents ?? 0) / 100).toFixed(2)} for the charges shown. I can revoke authorization by contacting PropLane before the debit is processed.`
              : "I authorize PropLane to save this bank account and debit it for payments I approve, and for recurring autopay only if I separately enable it. I can revoke authorization by contacting PropLane with 30 days' notice."}</span>
          </label>
          <Button type="submit" disabled={busy || !consent}>{busy ? "Confirming…" : kind === "payment" ? "Pay from bank" : "Save bank account"}</Button>
        </form>
      ) : null}
      {status === "verification" ? (
        <form onSubmit={verifyDeposits} className="space-y-3">
          <p className="text-sm font-medium">Verify your bank account</p>
          <FieldSingleSelect label="Verification method" value={verificationKind}
            onChange={(value) => setVerificationKind(value as "code" | "amounts")}
            options={[{ value: "code", label: "Bank statement code" },
              { value: "amounts", label: "Two deposit amounts" }]} />
          {verificationKind === "code" ? (
            <label className="block text-sm">Code<Input name="descriptorCode" autoComplete="off" placeholder="SM1234" required /></label>
          ) : (
            <div className="flex gap-3">
              <label className="block flex-1 text-sm">First amount (cents)<Input name="firstAmount" type="number" min="1" max="99" required /></label>
              <label className="block flex-1 text-sm">Second amount (cents)<Input name="secondAmount" type="number" min="1" max="99" required /></label>
            </div>
          )}
          <Button type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify bank"}</Button>
        </form>
      ) : null}
      {status === "clearing" ? <p className="text-sm font-medium">Bank payment processing</p> : null}
      {status === "paid" ? <p className="text-sm font-medium">{kind === "payment" ? "Payment received" : "Bank account saved"}</p> : null}
      {status === "review" ? <p className="text-sm font-medium">Bank payment needs review</p> : null}
      {status !== "entry" ? <Button type="button" variant="outline" disabled={busy} onClick={refresh}>Check status</Button> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
