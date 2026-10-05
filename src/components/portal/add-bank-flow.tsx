"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { PayoutBankSheet } from "@/components/portal/payout-bank-sheet";
import { PayoutVerifySheet, type VerifyStatus } from "@/components/portal/payout-verify-sheet";
import type { PortalPayoutsPortalKind } from "@/components/portal/portal-payouts-panel";

/** Server bases per portal for account identity and bank destinations. */
export const ADD_BANK_BASES: Record<PortalPayoutsPortalKind, { apiBase: string; connectBase: string }> = {
  manager: { apiBase: "/api/stripe", connectBase: "/api/stripe/connect" },
  vendor: { apiBase: "/api/vendor", connectBase: "/api/vendor/stripe-connect" },
};

type FlowStep = "checking" | "verify" | "bank" | "blocked";

/**
 * The one decision the Add-bank flow makes: a connected account that has not
 * finished identity uses the in-app verification sheet. A verified or pending
 * identity can add a bank if its bank-write permission allows it, including a
 * co-manager who cannot submit the owner's identity form.
 */
export function addBankFlowStart(identity: {
  status?: VerifyStatus;
  isApplicationCollected?: boolean;
  fallbackToEmbedded?: boolean;
  canSubmit?: boolean;
} | null): "verify" | "bank" | "blocked" {
  if (!identity || !identity.isApplicationCollected || identity.fallbackToEmbedded) return "blocked";
  if (identity.status === "verified" || identity.status === "pending") return "bank";
  return identity.canSubmit === false ? "blocked" : "verify";
}

/**
 * Add a bank account — the ONLY add-bank entry (Settings → Balance & payouts →
 * Bank accounts +, and Finances Withdraw when there is no bank yet). Always in
 * PropLane's own popup: never a new tab, never an Account Link.
 *
 *  - identity due → in-app owner identity verification.
 *  - identity verified or pending → in-app manual bank/debit card sheet.
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
  const { connectBase } = ADD_BANK_BASES[portal];
  const [step, setStep] = useState<FlowStep>("checking");
  const [blockedMessage, setBlockedMessage] = useState("");
  const runRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const run = ++runRef.current;
    setStep("checking");
    void (async () => {
      let identity: { status?: VerifyStatus; isApplicationCollected?: boolean; fallbackToEmbedded?: boolean; canSubmit?: boolean } | null = null;
      try {
        const res = await fetch(`${connectBase}/identity`, { credentials: "include" });
        if (res.ok) {
          identity = await res.json();
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setBlockedMessage(body.error ?? "Payout setup is unavailable. Contact support.");
        }
      } catch {
        setBlockedMessage("Payout setup is unavailable. Try again shortly.");
      }
      if (runRef.current === run) {
        const next = addBankFlowStart(identity);
        if (next === "blocked" && identity) setBlockedMessage(identity.canSubmit === false
          ? "The payout account owner must verify their identity before a bank can be added."
          : "This payout account needs a Stripe sign-in outside PropLane. Contact support to review payout setup.");
        setStep(next);
      }
    })();
    return () => {
      runRef.current++;
    };
  }, [open, connectBase]);

  const onVerified = useCallback(async (status: VerifyStatus) => {
    if (status !== "verified" && status !== "pending") return;
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
        open={open && (step === "checking" || step === "blocked")}
        title="Add a bank account"
        onClose={onClose}
        panelClassName="max-w-2xl"
        contextPanel={null}
        preview={null}
        assistantStrip={false}
        dataAttr="add-bank-flow"
      >
        {step === "blocked" ? <p role="alert" className="text-sm text-danger">{blockedMessage}</p> : (
          <div role="status" aria-label="Loading" className="h-48 w-full animate-pulse rounded-xl bg-accent/40" />
        )}
      </Modal>
      <PayoutVerifySheet open={open && step === "verify"} onClose={onClose} connectBase={connectBase} onVerified={(status) => void onVerified(status)} />
      <PayoutBankSheet
        open={open && step === "bank"}
        onClose={onClose}
        apiBase={connectBase}
        onAdded={() => onAdded?.()}
      />
    </>
  );
}
