"use client";

import { useCallback, useEffect, useState } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";

export type ResidentLeaseSigningFee = {
  ready: boolean;
  feeCents: number;
  paid: boolean;
  managerUserId: string;
  propertyId: string | null;
  /** Re-read the fee after a payment returns from Stripe. */
  refresh: () => Promise<void>;
};

const IDLE = {
  ready: false,
  feeCents: 0,
  paid: false,
  managerUserId: "",
  propertyId: null as string | null,
};

/**
 * The lease signing fee for one lease, as the SERVER resolved it. A lease the
 * resident cannot see, or a manager with no fee configured, reads as no fee —
 * this hook never invents a price or a paid state.
 */
export function useResidentLeaseSigningFee(leaseId: string | null | undefined): ResidentLeaseSigningFee {
  const [state, setState] = useState(IDLE);
  const id = leaseId?.trim() ?? "";

  const load = useCallback(async () => {
    // The Seattle Homes sandbox doesn't model a lease signing fee — never
    // fetch this auth-gated route from /demo.
    if (!id || isDemoModeActive()) {
      setState({ ...IDLE, ready: true });
      return;
    }
    try {
      const res = await fetch(`/api/resident/lease-signing-fee?leaseId=${encodeURIComponent(id)}`);
      const data = (await res.json().catch(() => ({}))) as {
        feeCents?: number;
        paid?: boolean;
        managerUserId?: string;
        propertyId?: string | null;
      };
      if (!res.ok) {
        setState({ ...IDLE, ready: true });
        return;
      }
      setState({
        ready: true,
        feeCents: typeof data.feeCents === "number" ? data.feeCents : 0,
        paid: data.paid === true,
        managerUserId: typeof data.managerUserId === "string" ? data.managerUserId : "",
        propertyId: typeof data.propertyId === "string" ? data.propertyId : null,
      });
    } catch {
      setState({ ...IDLE, ready: true });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, refresh: load };
}
