"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HOUSEHOLD_CHARGES_EVENT,
  readChargesForResident,
  syncHouseholdChargesFromServer,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { canPayHouseholdChargeWithAxisAch } from "@/lib/household-charge-payment-eligibility";
import {
  atSigningAllowsSignature,
  atSigningTotalCents,
  chargesForLeaseSigning,
  unpaidAtSigningCharges,
} from "@/lib/lease-at-signing";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";

export type ResidentAtSigning = {
  /** The first server read finished, so `blocked` is an answer rather than a guess. */
  ready: boolean;
  /** Every at-signing line of this lease still owed, soonest first. */
  charges: HouseholdCharge[];
  /** The sum of `charges` - the amount of the ONE payment, before any processing fee. */
  totalCents: number;
  /** True while any at-signing line is unpaid: Sign stays off. */
  blocked: boolean;
  /** Re-read the charges from the server (the Stripe webhook is what marks them paid). */
  refresh: () => Promise<void>;
  /** After a checkout completes: re-read until the webhook has marked every line paid, or give up quietly. */
  waitForSettled: () => Promise<boolean>;
};

type LeaseRef = {
  axisId?: string | null;
  residentEmail?: string | null;
  propertyId?: string | null;
  leaseKind?: string | null;
  jointLeaseMembers?: ReadonlyArray<{ applicationId?: string | null; residentEmail?: string | null }> | null;
} | null;

const SETTLE_POLL_MS = 1500;
const SETTLE_MAX_TRIES = 20;

/**
 * What the resident still owes before they may sign THIS lease, read from the server's charge records.
 * The decision itself is `lease-at-signing.ts`; this only supplies the lease's lines and keeps them fresh.
 * Signing is blocked from the first render until the first read says otherwise, so a slow network can
 * never flash an enabled Sign button.
 */
export function useResidentAtSigning(lease: LeaseRef, email: string, userId: string | null): ResidentAtSigning {
  const [tick, setTick] = useState(0);
  // The lease whose charges were last read from the server. `ready` is derived from it, so a lease that
  // arrives (or changes) is "not ready" - and signing stays off - until ITS charges have been read.
  const [readFor, setReadFor] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const emailKey = email.trim().toLowerCase();
  const leaseKey = lease ? `${lease.axisId ?? ""}|${lease.residentEmail ?? ""}|${lease.propertyId ?? ""}` : "";
  const active = Boolean(lease);
  const readKey = active && emailKey ? `${emailKey}|${leaseKey}` : "idle";
  const ready = readKey === "idle" || readFor === readKey;

  const refresh = useCallback(async () => {
    // No lease awaiting a signature (or nobody signed in): nothing to gate, and no reason to hit the server.
    if (readKey === "idle") return;
    try {
      await syncHouseholdChargesFromServer(true, { skipReconcile: true });
    } catch {
      // The local copy is still the best answer we have; the server gate is the one that decides.
    } finally {
      if (mounted.current) {
        setReadFor(readKey);
        setTick((n) => n + 1);
      }
    }
  }, [readKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onCharges = () => setTick((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, onCharges);
    return () => window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, onCharges);
  }, []);

  const leaseCharges = useMemo(
    () => {
      if (!lease || !emailKey) return [];
      const members = lease.leaseKind === "joint_bundle" ? lease.jointLeaseMembers ?? [] : [];
      const scoped = chargesForLeaseSigning(
        readChargesForResident(emailKey, userId),
        {
          applicationIds: [lease.axisId ?? "", ...members.map((m) => m.applicationId ?? "")].filter((id) => id.trim()),
          residentEmails: [emailKey, lease.residentEmail ?? "", ...members.map((m) => m.residentEmail ?? "")].filter((e) =>
            e.trim(),
          ),
          propertyId: lease.propertyId,
        },
        normalizeApplicationAxisId,
      );
      // Only the signer's own lines gate the signer.
      return scoped.filter((c) => (c.residentUserId && userId ? c.residentUserId === userId : c.residentEmail.trim().toLowerCase() === emailKey));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` re-reads the charge store
    [leaseKey, emailKey, userId, tick],
  );

  // Only a line the resident can pay in PropLane gates the signature (the server applies the same rule);
  // one the manager collects offline offers no checkout, so it never traps them behind a payment.
  const charges = useMemo(
    () => unpaidAtSigningCharges(leaseCharges).filter((c) => canPayHouseholdChargeWithAxisAch(c)),
    [leaseCharges],
  );
  const totalCents = useMemo(() => atSigningTotalCents(charges), [charges]);

  const waitForSettled = useCallback(async () => {
    for (let attempt = 0; attempt < SETTLE_MAX_TRIES; attempt += 1) {
      await refresh();
      if (!mounted.current) return false;
      const fresh = readChargesForResident(emailKey, userId);
      const now = chargesForLeaseSigning(
        fresh,
        {
          applicationIds: lease?.axisId ? [lease.axisId] : [],
          residentEmails: [emailKey],
          propertyId: lease?.propertyId,
        },
        normalizeApplicationAxisId,
      );
      if (atSigningAllowsSignature(now.filter((c) => canPayHouseholdChargeWithAxisAch(c)))) return true;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
    return false;
  }, [emailKey, lease, refresh, userId]);

  return {
    ready,
    charges,
    totalCents,
    blocked: !ready || charges.length > 0,
    refresh,
    waitForSettled,
  };
}
