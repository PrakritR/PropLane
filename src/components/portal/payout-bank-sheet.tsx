"use client";

import { useState } from "react";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { CreditCard, Landmark, Link2 } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Add-a-bank sheet (PLAN-0920-1500 part B). Three ways in, all tokenized in
 * the browser with Stripe.js — the server only ever sees a token id or a
 * Financial Connections account id, never a raw routing/account number, card
 * number, or CVC. Rendered in-page inside PropLane's own modal chrome; the
 * "Link instantly" mode opens Stripe's Financial Connections modal via
 * `collectFinancialConnectionsAccounts`, never a new tab.
 */

export type PayoutDestinationSummary = {
  id: string;
  kind: "bank" | "card";
  label: string;
  last4: string;
  status: "verified" | "verifying" | "errored";
  default: boolean;
};

type BankMode = "instant" | "manual" | "card";

// Client bundle only — Next.js inlines `NEXT_PUBLIC_*` vars at build time.
// Same pattern as `stripe-checkout-modal.tsx`.
const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as (T & { error?: string }) | { error?: string };
    if (!res.ok) return { ok: false, error: json.error ?? "Something went wrong." };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, error: "Something went wrong." };
  }
}

function ModeRow({
  active,
  onSelect,
  icon,
  title,
  detail,
  dataAttr,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
  dataAttr: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-attr={dataAttr}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border border-border px-3 py-2.5 text-left",
        active ? "border-primary/50 bg-primary/[0.04]" : "",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/40 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted">{detail}</span>
      </span>
    </button>
  );
}

function BankSheetContent({
  open,
  apiBase,
  onAdded,
  onClose,
}: {
  open: boolean;
  apiBase: string;
  onAdded: (destination: PayoutDestinationSummary) => void;
  onClose: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [mode, setMode] = useState<BankMode>("instant");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [accountHolderName, setAccountHolderName] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountType, setAccountType] = useState<"checking" | "savings">("checking");

  async function addViaFinancialConnections() {
    if (!stripe) {
      setError("Stripe failed to load.");
      return;
    }
    const session = await postJson<{ clientSecret: string }>(`${apiBase}/financial-connections/session`, {});
    if (!session.ok) {
      setError(session.error);
      return;
    }
    const result = await stripe.collectFinancialConnectionsAccounts({ clientSecret: session.data.clientSecret });
    if (result.error || !result.financialConnectionsSession) {
      setError(result.error?.message ?? "Could not link your bank.");
      return;
    }
    const account = result.financialConnectionsSession.accounts[0];
    if (!account) {
      setError("No bank account was linked.");
      return;
    }
    const attached = await postJson<{ destination: PayoutDestinationSummary }>(`${apiBase}/financial-connections/attach`, {
      accountId: account.id,
    });
    if (!attached.ok) {
      setError(attached.error);
      return;
    }
    onAdded(attached.data.destination);
  }

  async function addViaManualBank() {
    if (!stripe) {
      setError("Stripe failed to load.");
      return;
    }
    if (!accountHolderName.trim() || !routingNumber.trim() || !accountNumber.trim()) {
      setError("Fill in every field.");
      return;
    }
    const tokenResult = await stripe.createToken("bank_account", {
      country: "US",
      currency: "usd",
      routing_number: routingNumber.trim(),
      account_number: accountNumber.trim(),
      account_holder_name: accountHolderName.trim(),
      account_holder_type: "individual",
      account_type: accountType,
    });
    if (tokenResult.error || !tokenResult.token) {
      setError(tokenResult.error?.message ?? "Could not verify that bank account.");
      return;
    }
    const added = await postJson<{ destination: PayoutDestinationSummary }>(`${apiBase}/bank-accounts`, {
      token: tokenResult.token.id,
    });
    if (!added.ok) {
      setError(added.error);
      return;
    }
    onAdded(added.data.destination);
  }

  async function addViaCard() {
    if (!stripe || !elements) {
      setError("Stripe failed to load.");
      return;
    }
    const cardElement = elements.getElement(CardElement);
    if (!cardElement) {
      setError("Enter your card details.");
      return;
    }
    const tokenResult = await stripe.createToken(cardElement);
    if (tokenResult.error || !tokenResult.token) {
      setError(tokenResult.error?.message ?? "Could not verify that card.");
      return;
    }
    const added = await postJson<{ destination: PayoutDestinationSummary }>(`${apiBase}/bank-accounts`, {
      token: tokenResult.token.id,
    });
    if (!added.ok) {
      // The server rejects a credit card at this same 422 — its message
      // already says so, no separate client-side funding check needed.
      setError(added.error);
      return;
    }
    onAdded(added.data.destination);
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "instant") await addViaFinancialConnections();
      else if (mode === "manual") await addViaManualBank();
      else await addViaCard();
    } finally {
      setSubmitting(false);
    }
  }

  const note =
    mode === "instant"
      ? "Opens your bank's sign-in inside PropLane"
      : mode === "manual"
        ? "Two small deposits confirm it in 1–2 days"
        : "Used only for Instant payouts";

  return (
    <Modal
      open={open}
      title="Add a bank account"
      onClose={onClose}
      panelClassName="max-w-md"
      footer={
        <ModalFooter>
          <Button type="button" onClick={submit} disabled={submitting} data-attr="bank-sheet-submit">
            Add account
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-2">
        <ModeRow
          active={mode === "instant"}
          onSelect={() => setMode("instant")}
          icon={<Link2 className="size-4" aria-hidden />}
          title="Link instantly"
          detail="Sign in to your bank · verified now"
          dataAttr="bank-mode-instant"
        />
        <ModeRow
          active={mode === "manual"}
          onSelect={() => setMode("manual")}
          icon={<Landmark className="size-4" aria-hidden />}
          title="Enter routing and account number"
          detail="Verified with two small deposits · 1–2 days"
          dataAttr="bank-mode-manual"
        />
        <ModeRow
          active={mode === "card"}
          onSelect={() => setMode("card")}
          icon={<CreditCard className="size-4" aria-hidden />}
          title="Debit card for instant payouts"
          detail="30 minutes or less · 1% fee"
          dataAttr="bank-mode-card"
        />
      </div>

      {mode === "manual" ? (
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted" htmlFor="bank-holder-name">
              Account holder
            </label>
            <input
              id="bank-holder-name"
              value={accountHolderName}
              onChange={(e) => setAccountHolderName(e.target.value)}
              data-attr="bank-holder-name"
              className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted" htmlFor="bank-routing">
              Routing number
            </label>
            <input
              id="bank-routing"
              inputMode="numeric"
              value={routingNumber}
              onChange={(e) => setRoutingNumber(e.target.value.replace(/[^0-9]/g, ""))}
              data-attr="bank-routing-number"
              className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted" htmlFor="bank-account-number">
              Account number
            </label>
            <input
              id="bank-account-number"
              inputMode="numeric"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ""))}
              data-attr="bank-account-number"
              className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted" htmlFor="bank-account-type">
              Type
            </label>
            <select
              id="bank-account-type"
              value={accountType}
              onChange={(e) => setAccountType(e.target.value === "savings" ? "savings" : "checking")}
              data-attr="bank-account-type"
              className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none"
            >
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
            </select>
          </div>
        </div>
      ) : null}

      {mode === "card" ? (
        <div className="mt-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted">Debit card</label>
          <div className="rounded-xl border border-border bg-card px-3 py-3" data-attr="bank-card-element">
            <CardElement options={{ hidePostalCode: true }} />
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted" data-attr="bank-mode-note">
        {note}
      </p>

      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert" data-attr="bank-sheet-error">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export function PayoutBankSheet({
  open,
  onClose,
  apiBase,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** `/api/stripe/connect` for a manager, `/api/vendor/stripe-connect` for a vendor. */
  apiBase: string;
  onAdded: (destination: PayoutDestinationSummary) => void;
}) {
  return (
    <Elements stripe={stripePromise}>
      <BankSheetContent
        open={open}
        apiBase={apiBase}
        onAdded={(destination) => {
          onAdded(destination);
          onClose();
        }}
        onClose={onClose}
      />
    </Elements>
  );
}

/** Convenience mount point so a page component can render the sheet without wiring `Elements` itself. */
export function renderBankSheet(props: {
  open: boolean;
  onClose: () => void;
  apiBase: string;
  onAdded: (destination: PayoutDestinationSummary) => void;
}) {
  return <PayoutBankSheet {...props} />;
}
