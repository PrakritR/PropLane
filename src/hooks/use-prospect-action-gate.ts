"use client";

import type { ProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import {
  prospectGateKey,
  prospectPortalReturnPath,
  resolveProspectGateView,
  type ProspectActionKind,
  type ProspectGateView,
} from "@/lib/prospect-public-gate";

/**
 * A resident account is required for every prospect action (PLAN-0924-1421), so
 * this hook has no bypass state left — the gate resolves purely from the role
 * the visitor holds.
 */
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
} {
  const gateKey = prospectGateKey(action, propertyId);
  const portalReturn = propertyId.trim()
    ? prospectPortalReturnPath(action, { propertyId })
    : "";
  const gateView = resolveProspectGateView({
    gateKey,
    signedInNonResident,
    hasResidentRole: contactAutofill.ready && contactAutofill.hasResidentRole,
  });

  return {
    ready: contactAutofill.ready,
    gateKey,
    gateView,
    portalReturn,
  };
}
