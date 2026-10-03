"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { PayoutBankSheet } from "@/components/portal/payout-bank-sheet";
import { StripeConnectEmbedded } from "@/components/stripe-connect-embedded";
import type { PortalPayoutsPortalKind } from "@/components/portal/portal-payouts-panel";

/** Server bases per portal: the payouts API (balance) and the Connect API (account session, bank accounts). */
export const ADD_BANK_BASES: Record<PortalPayoutsPortalKind, { apiBase: string; connectBase: string }> = {
  manager: { apiBase: "/api/stripe", connectBase: "/api/stripe/connect" },
  vendor: { apiBase: "/api/vendor", connectBase: "/api/vendor/stripe-connect" },
};

type FlowStep = "checking" | "onboarding" | "bank";

/**
 * The one decision the Add-bank flow makes: a connected account that has not
 * finished identity (no account yet, or requirements still due) goes through
 * Stripe's embedded onboarding first — Stripe collects whatever identity it
 * legally requires there, so PropLane never shows it as a separate step. An
 * account whose identity is done (or already submitted for review) goes
 * straight to the in-app bank sheet.
 */
export function addBankFlowStart(identity: "done" | "needed" | "pending" | null | undefined): "onboarding" | "bank" {
  return identity === "done" || identity === "pending" ? "bank" : "onboarding";
}

/**
 * Add a bank account — the ONLY add-bank entry (Settings → Balance & payouts →
 * Bank accounts +, and Finances Withdraw when there is no bank yet). Always in
 * PropLane's own popup: never a new tab, never an Account Link.
 *
 *  - not ready to receive payouts → Stripe embedded onboarding; when it exits
 *    the bank list is re-read, and if onboarding added no bank the flow
 *    continues straight into the bank sheet.
 *  - ready → the in-app bank sheet (link instantly, or routing and account).
 */
export function AddBankFlow({
  open,
  onClose,
  portal,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  portal: PortalPayoutsPortalKind;
  /** A bank now exists on the account (added in the sheet or during onboarding). */
  onAdded?: () => void;
}) {
  const { apiBase, connectBase } = ADD_BANK_BASES[portal];
  const [step, setStep] = useState<FlowStep>("checking");
  const runRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const run = ++runRef.current;
    setStep("checking");
    void (async () => {
      let identity: "done" | "needed" | "pending" | null = null;
      try {
        const res = await fetch(`${apiBase}/payouts/balance`, { credentials: "include" });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { setup?: { identity?: "done" | "needed" | "pending" } } | null;
          identity = body?.setup?.identity ?? null;
        }
      } catch {
        identity = null;
      }
      if (runRef.current === run) setStep(addBankFlowStart(identity));
    })();
    return () => {
      runRef.current++;
    };
  }, [open, apiBase]);

  const onOnboardingExit = useCallback(async () => {
    const run = ++runRef.current;
    setStep("checking");
    let hasBank = false;
    try {
      const res = await fetch(`${connectBase}/bank-accounts`, { credentials: "include" });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { destinations?: unknown } | null;
        hasBank = Array.isArray(body?.destinations) && body.destinations.length > 0;
      }
    } catch {
      hasBank = false;
    }
    if (runRef.current !== run) return;
    if (hasBank) {
      onAdded?.();
      onClose();
      return;
    }
    setStep("bank");
  }, [connectBase, onAdded, onClose]);

  return (
    <>
      <Modal
        open={open && step !== "bank"}
        title="Add a bank account"
        onClose={onClose}
        panelClassName="max-w-2xl"
        contextPanel={null}
        preview={null}
        assistantStrip={false}
        dataAttr="add-bank-flow"
      >
        {step === "onboarding" ? (
          <div className="min-h-[24rem] w-full" data-attr="add-bank-onboarding">
            <StripeConnectEmbedded connectBase={connectBase} component="account_onboarding" onExit={() => void onOnboardingExit()} />
          </div>
        ) : (
          <div role="status" aria-label="Loading" className="h-48 w-full animate-pulse rounded-xl bg-accent/40" />
        )}
      </Modal>
      <PayoutBankSheet
        open={open && step === "bank"}
        onClose={onClose}
        apiBase={connectBase}
        onAdded={() => onAdded?.()}
      />
    </>
  );
}
