"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStripe } from "@/lib/stripe-browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PlaidLinkLauncher, type PlaidLinkSuccess } from "@/components/portal/plaid-link-button";


type BankStatus = "entry" | "verification" | "clearing" | "paid" | "review";

/** A bank the resident linked with Plaid: names and last four only. */
type LinkedBank = { id: string; institutionName: string | null; accountName: string | null; accountMask: string | null };

/** Bank numbers stay in the browser and go directly to Stripe.js. */
export function ResidentBankAccountForm({
  clientSecret,
  intentId,
  kind,
  amountCents,
  initialStatus = "entry",
  onComplete,
  onStatusChange,
  endpoint: endpointOverride,
}: {
  clientSecret: string;
  intentId: string;
  kind: "payment" | "setup";
  amountCents?: number;
  initialStatus?: BankStatus;
  onComplete?: () => void;
  onStatusChange?: (status: BankStatus) => void;
  /** A payment made from a phone-bound link reads and verifies through the link's own route (same answers, link session as the actor). */
  endpoint?: string;
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
  // Plaid is offered only for an in-app payment, and only when the server says it is enabled.
  // Anything else (disabled, a phone-bound link, a saved-bank setup) is the typed path, unchanged.
  const [plaidOn, setPlaidOn] = useState(false);
  const [typedNumbers, setTypedNumbers] = useState(false);
  const [linked, setLinked] = useState<LinkedBank | null>(null);
  const [verificationKind, setVerificationKind] = useState<"code" | "amounts">("code");

  const endpoint = endpointOverride ?? (kind === "payment" ? "/api/stripe/resident-ach-payment" : "/api/stripe/resident-bank-setup");
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

  const plaidEligible = kind === "payment" && !endpointOverride && status === "entry";
  useEffect(() => {
    if (!plaidEligible) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/api/plaid/status?purpose=resident_pay", { credentials: "include", cache: "no-store" });
        const result = await response.json() as { enabled?: boolean };
        if (live) setPlaidOn(response.ok && result.enabled === true);
      } catch { if (live) setPlaidOn(false); }
    })();
    return () => { live = false; };
  }, [plaidEligible]);

  async function exchangeLinkedBank(result: PlaidLinkSuccess) {
    setError(null);
    try {
      const response = await fetch("/api/resident/plaid/exchange", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicToken: result.publicToken, purpose: "resident_pay", accountId: result.accountId }),
      });
      const data = await response.json() as { item?: { id: string; institutionName: string | null; accountName: string | null; accountMask: string | null }; error?: string };
      if (!response.ok || !data.item) throw new Error(data.error ?? "Couldn't reach your bank.");
      setLinked(data.item);
      setConsent(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't reach your bank.");
    }
  }

  async function payWithLinkedBank() {
    if (!consent || !linked || busy) return;
    if (!Number.isSafeInteger(amountCents) || (amountCents ?? 0) <= 0) {
      setError("Payment amount needs review.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/stripe/resident-plaid-bank", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId: intentId, plaidItemId: linked.id, authorized: true }),
      });
      const result = await response.json() as { bankStatus?: BankStatus; paid?: boolean; error?: string };
      if (!response.ok || !result.bankStatus) throw new Error(result.error ?? "Bank payment needs review.");
      if (result.bankStatus === "paid" && result.paid !== true) throw new Error("Payment receipt needs review.");
      setStatus(result.bankStatus);
      onStatusChangeRef.current?.(result.bankStatus);
      if (result.bankStatus === "paid") onCompleteRef.current?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bank payment needs review.");
    } finally {
      setBusy(false);
    }
  }

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
      const stripe = await getStripe();
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
      {status === "entry" && plaidOn && !typedNumbers ? (
        <div className="space-y-3 ph-no-capture ph-no-record" data-attr="resident-bank-plaid">
          {linked ? (
            <>
              <p className="text-sm font-medium">
                {[linked.institutionName, linked.accountName].filter(Boolean).join(" ")}
                {linked.accountMask ? ` ••${linked.accountMask}` : ""}
              </p>
              <p className="text-sm">Verified</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} required />
                <span>{`I authorize PropLane to debit this bank account $${((amountCents ?? 0) / 100).toFixed(2)} for the charges shown, and to save it to my account for payments I approve, and for recurring autopay only if I separately enable it. I can revoke authorization by contacting PropLane.`}</span>
              </label>
              <Button type="button" disabled={busy || !consent} onClick={() => payWithLinkedBank()} data-attr="resident-bank-plaid-pay">
                {`Pay $${((amountCents ?? 0) / 100).toFixed(2)}`}
              </Button>
            </>
          ) : (
            <PlaidLinkLauncher
              purpose="resident_pay"
              endpoint="/api/resident/plaid/link-token"
              onSuccess={exchangeLinkedBank}
              onError={setError}
            >
              {({ start, busy }) => (
                <Button type="button" loading={busy} onClick={() => start()} data-attr="resident-bank-plaid-link">
                  Log in to your bank
                </Button>
              )}
            </PlaidLinkLauncher>
          )}
          <div>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setTypedNumbers(true)} data-attr="resident-bank-enter-numbers">
              Enter numbers instead
            </Button>
          </div>
        </div>
      ) : null}
      {status === "entry" && !(plaidOn && !typedNumbers) ? (
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
              : "I authorize PropLane to save this bank account and debit it for payments I approve, and for recurring autopay only if I separately enable it. I can revoke authorization by contacting PropLane."}</span>
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
