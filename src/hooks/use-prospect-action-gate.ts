"use client";

import { useEffect, useState } from "react";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import {
  hasProspectGuestContinue,
  markProspectGuestContinue,
  prospectGateKey,
  prospectPortalReturnPath,
  resolveProspectGateView,
  type ProspectActionKind,
  type ProspectGateView,
} from "@/lib/prospect-public-gate";

export function useProspectActionGate(
  action: ProspectActionKind,
  propertyId: string,
  signedInNonResident: boolean,
): {
  ready: boolean;
  gateKey: string;
  gateView: ProspectGateView;
  portalReturn: string;
  continueAsGuest: () => void;
} {
  const contactAutofill = useProspectContactAutofill();
  const gateKey = prospectGateKey(action, propertyId);
  const [guestBypass, setGuestBypass] = useState(false);
  const [guestContinued, setGuestContinued] = useState(false);

  useEffect(() => {
    if (!gateKey) {
      setGuestContinued(false);
      return;
    }
    setGuestContinued(hasProspectGuestContinue(gateKey));
  }, [gateKey]);

  const guestContinue = guestBypass || guestContinued;
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
    setGuestBypass(true);
  };

  return {
    ready: contactAutofill.ready,
    gateKey,
    gateView,
    portalReturn,
    continueAsGuest,
  };
}
