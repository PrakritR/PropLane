"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { ResidentBankAccountForm } from "@/components/portal/resident-bank-account-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  HOUSEHOLD_CHARGES_EVENT,
  readChargesForResident,
  syncHouseholdChargesFromServer,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { buildMoveInChargeGroups } from "@/lib/move-in-charge-group";
import {
  residentProcessingFeeDisplayLabel,
  residentPaymentMethodLabel,
  type ResidentAxisPaymentMethod,
} from "@/lib/payment-policy";
import {
  filterChargesForPayMethod,
  isPayableHouseholdCharge,
  residentPaymentMethodsForSurface,
} from "@/lib/platform/resident-payments";
import { parseMoneyAmount } from "@/lib/parse-money";

function centsFromLabel(label: string): number {
  return Math.round(parseMoneyAmount(label) * 100);
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

type CheckoutState = {
  chargeIds: string[];
  paymentMethod: ResidentAxisPaymentMethod;
  clientSecret: string | null;
  mode?: "checkout" | "manual_ach";
  paymentIntentId?: string;
  bankStatus?: "entry" | "verification" | "clearing" | "paid" | "review";
  loading: boolean;
  error: string | null;
  subtotalCents?: number;
  processingFeeCents?: number;
  totalCents?: number;
};

/**
 * "Have a waive code?" on the pay-before-signing step. A valid lease (or both) code cancels the lease fee on
 * the server exactly like the manager's per-lease waiver; this only sends the typed code and the lease id,
 * then asks the page to re-read the charges so the fee drops out of the total. The server decides everything
 * (whose lease, which manager's code, which property, paid or not, how many uses are left).
 */
function LeaseFeeWaiveCodeEntry({ leaseId, onWaived }: { leaseId: string; onWaived: () => void }) {
  const { showToast } = useAppUi();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    const typed = code.trim();
    if (!typed || applying) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/resident/lease-fee-waiver-code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leaseId, code: typed }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(payload.error ?? "That code could not be applied.");
        return;
      }
      setCode("");
      setOpen(false);
      showToast("Lease fee waived.");
      onWaived();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setApplying(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="mt-3 text-sm font-bold text-primary underline-offset-2 hover:underline"
        data-attr="resident-at-signing-waive-code-open"
        onClick={() => setOpen(true)}
      >
        Have a waive code?
      </button>
    );
  }
  return (
    <div className="mt-3" data-attr="resident-at-signing-waive-code">
      <div className="flex items-center gap-2">
        <Input
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void apply();
          }}
          aria-label="Waive code"
          placeholder="Code"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="font-mono uppercase"
          data-attr="resident-at-signing-waive-code-input"
        />
        <Button
          type="button"
          className="min-h-11"
          disabled={!code.trim() || applying}
          data-attr="resident-at-signing-waive-code-apply"
          onClick={() => apply()}
        >
          {applying ? "Applying…" : "Apply"}
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-sm font-semibold text-destructive" role="alert" data-attr="resident-at-signing-waive-code-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The one sign-and-pay payment.
 *
 * `mode="move-in"` (default) is the original after-signing card: the resident's move-in group.
 * `mode="at-signing"` is the same card moved in FRONT of the signature: the lease fee, deposit, move-in fee
 * and other lines collected at signing (`charges`, from `useResidentAtSigning`), paid in ONE Stripe checkout
 * for exactly their sum. The Sign action stays off until the Stripe webhook has marked every one paid;
 * `onCheckoutComplete` only starts the wait for that, it never unlocks anything itself.
 */
export function ResidentSignAndPayMoveIn({
  email,
  signed,
  mode = "move-in",
  charges: atSigningCharges,
  onCheckoutComplete,
  leaseId,
  onFeeWaived,
}: {
  email: string;
  signed: boolean;
  mode?: "move-in" | "at-signing";
  charges?: HouseholdCharge[];
  onCheckoutComplete?: () => void;
  /** The lease being signed. With it, a resident who still owes a lease fee may enter a waive code. */
  leaseId?: string | null;
  /** The lease fee was waived by a code: re-read the charges so it drops out of the total. */
  onFeeWaived?: () => void;
}) {
  const atSigning = mode === "at-signing";
  const { showToast } = useAppUi();
  const [tick, setTick] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<ResidentAxisPaymentMethod>("card");
  const [checkout, setCheckout] = useState<CheckoutState | null>(null);

  const paymentMethodOptions = useMemo(
    () =>
      residentPaymentMethodsForSurface(false).map((id) => ({
        id,
        label: residentPaymentMethodLabel(id),
      })),
    [],
  );

  useEffect(() => {
    const onCharges = () => setTick((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, onCharges);
    return () => window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, onCharges);
  }, []);

  const moveInGroup = useMemo(() => {
    if (atSigning) return null;
    const pending = readChargesForResident(email, null).filter((c) => isPayableHouseholdCharge(c) ||
      (c.status === "processing" && c.stripeCheckoutSessionId?.startsWith("pi_")));
    const groups = buildMoveInChargeGroups(pending);
    return groups[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick refreshes charge reads
  }, [email, signed, tick, atSigning]);

  useEffect(() => {
    if (!signed || atSigning) return;
    void syncHouseholdChargesFromServer(true, { skipReconcile: true });
  }, [signed, atSigning]);

  // The lines this payment settles: the at-signing set as given, or the move-in group.
  const items = useMemo<HouseholdCharge[]>(
    () => (atSigning ? atSigningCharges ?? [] : moveInGroup?.items ?? []),
    [atSigning, atSigningCharges, moveInGroup],
  );

  const payableItems = useMemo(
    () => filterChargesForPayMethod(items).filter((c) => c.status === "pending" || c.status === "failed"),
    [items],
  );
  const payableIds = useMemo(() => payableItems.map((c) => c.id), [payableItems]);
  const manualProcessingRefs = items.filter(item => item.status === "processing")
    .map(item => item.stripeCheckoutSessionId);
  const manualProcessingIntentId = manualProcessingRefs.length > 0 &&
    manualProcessingRefs.every(ref => ref === manualProcessingRefs[0]) &&
    manualProcessingRefs[0]?.startsWith("pi_") ? manualProcessingRefs[0] : null;
  // Only an unpaid lease fee can be waived, and only while the resident can still pay it here.
  const canEnterWaiveCode =
    atSigning && Boolean(leaseId) && payableItems.some((c) => c.kind === "lease_fee" && !c.waivedAt);

  const loadCheckout = useCallback(
    async (chargeIds: string[], method: ResidentAxisPaymentMethod) => {
      setCheckout({
        chargeIds,
        paymentMethod: method,
        clientSecret: null,
        loading: true,
        error: null,
      });
      try {
        const res = await fetch("/api/stripe/household-charge-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chargeIds, embedded: true, paymentMethod: method }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          clientSecret?: string;
          mode?: "checkout" | "manual_ach";
          paymentIntentId?: string;
          bankStatus?: "entry" | "verification" | "clearing" | "paid" | "review";
          error?: string;
          subtotalCents?: number;
          processingFeeCents?: number;
          totalCents?: number;
        };
        if (!res.ok || !payload.clientSecret || (method === "ach" &&
          (payload.mode !== "manual_ach" || !payload.paymentIntentId))) {
          setCheckout({
            chargeIds,
            paymentMethod: method,
            clientSecret: null,
            loading: false,
            error: payload.error ?? (method === "ach" ? "Bank payment needs review." : "Could not start payment."),
          });
          return;
        }
        setCheckout({
          chargeIds,
          paymentMethod: method,
          clientSecret: payload.clientSecret,
          mode: payload.mode,
          paymentIntentId: payload.paymentIntentId,
          bankStatus: payload.bankStatus,
          loading: false,
          error: null,
          subtotalCents: payload.subtotalCents,
          processingFeeCents: payload.processingFeeCents,
          totalCents: payload.totalCents,
        });
      } catch {
        setCheckout({
          chargeIds,
          paymentMethod: method,
          clientSecret: null,
          loading: false,
          error: "Could not reach checkout.",
        });
      }
    },
    [],
  );

  const resumeManualAch = useCallback(async (paymentIntentId: string) => {
    const response = await fetch(`/api/stripe/resident-ach-payment?payment_intent_id=${encodeURIComponent(paymentIntentId)}`,
      { credentials: "include", cache: "no-store" });
    const result = await response.json() as { clientSecret?: string; chargeIds?: string[];
      bankStatus?: CheckoutState["bankStatus"]; subtotalCents?: number; totalCents?: number; error?: string };
    if (!response.ok || !result.clientSecret || !Array.isArray(result.chargeIds) || !result.bankStatus) {
      showToast(result.error ?? "Bank payment needs review.");
      return;
    }
    setCheckout({ chargeIds: result.chargeIds, paymentMethod: "ach", clientSecret: result.clientSecret,
      mode: "manual_ach", paymentIntentId, bankStatus: result.bankStatus,
      subtotalCents: result.subtotalCents, totalCents: result.totalCents, loading: false, error: null });
    await syncHouseholdChargesFromServer(true, { skipReconcile: true });
    setTick((n) => n + 1);
  }, [showToast]);

  if (atSigning && items.length === 0) return null;

  if (!atSigning && !signed) {
    return (
      <section className="rounded-2xl border border-border bg-card p-4" data-jr-sp-pay>
        <h2 className="text-sm font-bold text-foreground">Move-in costs</h2>
        <p className="mt-2 text-sm font-semibold text-muted">Sign the lease to unlock move-in payment.</p>
      </section>
    );
  }

  if (!atSigning && !moveInGroup) {
    return (
      <section className="rounded-2xl border border-border bg-card p-4" data-jr-sp-pay>
        <h2 className="text-sm font-bold text-foreground">Move-in costs</h2>
        <p className="mt-2 text-sm font-semibold text-foreground">No move-in balance due right now.</p>
      </section>
    );
  }

  const feeCents = (checkout?.processingFeeCents ?? 0) > 0 ? checkout!.processingFeeCents! : 0;
  // The itemized lines ARE the amount: the subtotal is their sum, and the Stripe session is created from
  // the very same charges, so what is shown is what is charged (plus a processing fee, shown on its own).
  const subtotalCents = (atSigning ? payableItems : items).reduce((sum, c) => sum + centsFromLabel(c.balanceLabel), 0);
  const totalCents = checkout?.totalCents ?? subtotalCents + feeCents;
  const allClearing = items.length > 0 && items.every((c) => c.status === "processing");

  return (
    <section
      className="rounded-2xl border border-border bg-card p-4"
      data-jr-sp-pay
      data-attr={atSigning ? "resident-at-signing-pay" : undefined}
    >
      <h2 className="text-sm font-bold text-foreground">{atSigning ? "Pay before you sign" : "Move-in costs"}</h2>
      <ul className="mt-3 divide-y divide-border rounded-xl border border-border" data-attr="resident-at-signing-lines">
        {items.map((item: HouseholdCharge) => (
          <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="truncate text-sm font-semibold text-foreground">{item.title}</span>
            <span className="shrink-0 text-sm font-bold tabular-nums">
              {atSigning && item.status === "processing" ? "Clearing" : item.balanceLabel}
            </span>
          </li>
        ))}
      </ul>
      {atSigning ? (
        <p className="mt-3 text-sm font-semibold text-foreground tabular-nums" data-attr="resident-at-signing-subtotal">
          Charges {formatUsd(subtotalCents)}
        </p>
      ) : null}
      <p className="mt-1 text-sm font-bold text-foreground tabular-nums" data-attr="resident-at-signing-total">
        Total {formatUsd(totalCents)}
      </p>
      <p className="mt-1 text-xs font-semibold text-muted">
        {feeCents > 0 ? `Processing fee ${formatUsd(feeCents)}` : "Processing fee: None"}
      </p>
      {manualProcessingIntentId ? (
        <Button type="button" variant="outline" className="mt-3" data-attr="resident-move-in-resume-bank"
          onClick={() => resumeManualAch(manualProcessingIntentId)}>
          Verify bank or check status
        </Button>
      ) : null}
      {!manualProcessingIntentId ? <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {paymentMethodOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-bold ${
              paymentMethod === option.id ? "border-primary bg-accent text-foreground" : "border-border bg-card"
            }`}
            onClick={() => {
              setPaymentMethod(option.id);
              setCheckout(null);
              void loadCheckout(payableIds, option.id);
            }}
          >
            {option.label}
            <span className="mt-0.5 block text-[11px] font-semibold text-muted">
              {residentProcessingFeeDisplayLabel(option.id)}
            </span>
          </button>
        ))}
      </div> : null}
      {canEnterWaiveCode && !checkout?.clientSecret ? (
        <LeaseFeeWaiveCodeEntry
          leaseId={leaseId as string}
          onWaived={() => {
            // The session (if one was opened) was priced with the fee in it: drop it so the resident
            // starts a new one for the corrected total.
            setCheckout(null);
            onFeeWaived?.();
          }}
        />
      ) : null}
      {checkout?.loading ? <p className="mt-3 text-sm text-muted">Loading secure checkout…</p> : null}
      {checkout?.error ? (
        <p className="mt-3 text-sm font-semibold text-destructive" role="alert">{checkout.error}</p>
      ) : null}
      {checkout?.mode === "manual_ach" && checkout.clientSecret && checkout.paymentIntentId ? (
        <div className="mt-3 rounded-2xl border border-border bg-card p-4">
          <ResidentBankAccountForm key={checkout.paymentIntentId} kind="payment"
            clientSecret={checkout.clientSecret} intentId={checkout.paymentIntentId}
            amountCents={checkout.totalCents} initialStatus={checkout.bankStatus}
            onStatusChange={(status) => { if (status !== "entry") {
              void syncHouseholdChargesFromServer(true, { skipReconcile: true }).then(() => setTick((n) => n + 1));
            } }} onComplete={onCheckoutComplete} />
        </div>
      ) : checkout?.clientSecret ? (
        <div className="mt-3 min-h-[min(50vh,22rem)] overflow-hidden rounded-2xl border border-border bg-card">
          <StripeEmbeddedCheckout clientSecret={checkout.clientSecret} onComplete={onCheckoutComplete} />
        </div>
      ) : (
        <Button
          type="button"
          className="mt-4 min-h-11"
          disabled={allClearing}
          data-attr={atSigning ? "resident-at-signing-pay-button" : undefined}
          onClick={() => {
            if (payableIds.length === 0) {
              showToast("Nothing to pay.");
              return;
            }
            void loadCheckout(payableIds, paymentMethod);
          }}
        >
          {allClearing ? "Bank transfer clearing" : `Pay ${formatUsd(totalCents)}`}
        </Button>
      )}
    </section>
  );
}
