"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESIDENT_MANUAL_PAYMENT_AUTO_CHECK_MS,
  checkResidentManualPayment,
  type ResidentManualPaymentChannel,
} from "@/lib/resident-manual-payment-client";
import type { HouseholdCharge } from "@/lib/household-charges";

type UseResidentManualPaymentCheckArgs = {
  enabled: boolean;
  chargeIds: string[];
  channel: ResidentManualPaymentChannel;
  autoCheck?: boolean;
  onPaid?: (charges: HouseholdCharge[]) => void;
};

export function useResidentManualPaymentCheck({
  enabled,
  chargeIds,
  channel,
  autoCheck = true,
  onPaid,
}: UseResidentManualPaymentCheckArgs) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const onPaidRef = useRef(onPaid);
  // Synced in an effect: writing a ref during render is unsafe under concurrent
  // rendering. `runCheck` only reads it from an async callback the resident
  // triggers, which is long after the effect has flushed.
  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);

  const runCheck = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!enabled || paid) return { paid: false as const };
      if (!options?.silent) setError(null);
      setChecking(true);
      try {
        const result = await checkResidentManualPayment(chargeIds, channel);
        if (!result.ok) {
          if (!options?.silent) setError(result.error);
          return { paid: false as const };
        }
        if (!result.paid) {
          if (!options?.silent) setError(result.message);
          return { paid: false as const };
        }
        setPaid(true);
        setError(null);
        onPaidRef.current?.(result.charges);
        return { paid: true as const, charges: result.charges };
      } finally {
        setChecking(false);
      }
    },
    [channel, chargeIds, enabled, paid],
  );

  useEffect(() => {
    setPaid(false);
    setError(null);
  }, [channel, chargeIds.join(",")]);

  useEffect(() => {
    if (!enabled || !autoCheck || paid) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void runCheck({ silent: true });
    };
    const timer = window.setInterval(tick, RESIDENT_MANUAL_PAYMENT_AUTO_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [autoCheck, enabled, paid, runCheck]);

  return { checking, error, paid, runCheck, setError };
}
