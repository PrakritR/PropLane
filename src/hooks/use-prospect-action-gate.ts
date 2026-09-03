"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import type { ProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import {
  hasProspectGuestContinue,
  markProspectGuestContinue,
  prospectGateKey,
  prospectPortalReturnPath,
  resolveProspectGateView,
  type ProspectActionKind,
  type ProspectGateView,
} from "@/lib/prospect-public-gate";

/**
 * Guest-continue is written to sessionStorage only by this hook, so there is
 * nothing to subscribe to — the snapshot is re-read on every render instead.
 */
const subscribeToNothing = () => () => {};

export function useProspectActionGate(
  action: ProspectActionKind,
  propertyId: string,
  signedInNonResident: boolean,
  contactAutofill: ProspectContactAutofill,
): {
  ready: boolean;
  gateKey: string;
  gateView: ProspectGateView;
  portalReturn: string;
  continueAsGuest: () => void;
} {
  const gateKey = prospectGateKey(action, propertyId);
  // Keyed on the gate rather than a boolean, so switching properties drops the
  // bypass without an effect that resets state.
  const [bypassedGateKey, setBypassedGateKey] = useState("");

  const readGuestContinued = useCallback(
    () => (gateKey ? hasProspectGuestContinue(gateKey) : false),
    [gateKey],
  );
  // Server snapshot is false: sessionStorage is unreadable during SSR, and
  // reading it while rendering would desync hydration.
  const guestContinued = useSyncExternalStore(subscribeToNothing, readGuestContinued, () => false);

  const guestContinue = (Boolean(gateKey) && bypassedGateKey === gateKey) || guestContinued;
  const portalReturn = propertyId.trim()
    ? prospectPortalReturnPath(action, { propertyId })
    : "";
  const gateView = resolveProspectGateView({
    gateKey,
    guestContinue,
    signedInNonResident,
    hasResidentRole: contactAutofill.ready && contactAutofill.hasResidentRole,
  });

  const continueAsGuest = () => {
    if (gateKey) markProspectGuestContinue(gateKey);
    setBypassedGateKey(gateKey);
  };

  return {
    ready: contactAutofill.ready,
    gateKey,
    gateView,
    portalReturn,
    continueAsGuest,
  };
}
