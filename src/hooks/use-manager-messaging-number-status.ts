"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { WORKSPACE_SELECTION_EVENT, selectedWorkspaceId } from "@/lib/workspaces/selection";
import {
  loadManagerMessagingNumberStatusClient,
  readManagerMessagingNumberStatusClient,
  resetManagerMessagingNumberStatusClientCache,
  subscribeManagerMessagingNumberStatusClient,
} from "@/lib/sms/manager-messaging-number-client";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

export type ManagerMessagingNumberStatusState = {
  ready: boolean;
  resolved: boolean;
  statusError: boolean;
  status: ManagerMessagingNumberStatus | null;
  retry: () => void;
};

/**
 * The Seattle Homes sandbox's own work number — a fully set-up, sendable line
 * on a paid plan, so `/demo` never fetches `/api/manager/messaging-number`
 * (an auth-gated route a signed-out `/demo` visitor can never legitimately
 * call) and never shows the real "Phone number not set up" nudge. Keeping
 * this static also means a captain or teammate who happens to be signed in
 * while they preview `/demo` in the same browser never has their OWN real
 * messaging status fetched and rendered on a public sandbox page.
 */
const DEMO_MESSAGING_NUMBER_STATUS: ManagerMessagingNumberStatus = {
  mode: "automatic",
  workspaceRole: "primary",
  provisioningAvailable: false,
  sendingAvailable: true,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  number: {
    state: "active",
    registrationState: "approved",
    carrierRegistrationState: "registered",
    attachmentState: "attached",
    phoneNumber: "+1 (206) 555-0100",
    lastError: null,
  },
  canRequest: false,
  requestedAtSignup: true,
  canSend: true,
  personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
};

const DEMO_MESSAGING_NUMBER_STATE: ManagerMessagingNumberStatusState = {
  ready: true,
  resolved: true,
  statusError: false,
  status: DEMO_MESSAGING_NUMBER_STATUS,
  retry: () => {},
};

export function useManagerMessagingNumberStatus(): ManagerMessagingNumberStatusState {
  const { userId, ready: sessionReady } = useManagerUserId();
  const [attempt, setAttempt] = useState(0);
  const demoActive = isDemoModeActive();

  const snapshot = useSyncExternalStore(
    subscribeManagerMessagingNumberStatusClient,
    () => readManagerMessagingNumberStatusClient(userId),
    () => undefined,
  );

  const retry = useCallback(() => {
    resetManagerMessagingNumberStatusClientCache();
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (demoActive || !sessionReady || !userId) return;
    void loadManagerMessagingNumberStatusClient(userId);
  }, [attempt, demoActive, sessionReady, userId]);

  // A work number belongs to the WORKSPACE, so the status is stale the moment
  // the switcher moves. Drop the cache and read again only when the selected
  // workspace actually changed — the selection event also fires on refreshes.
  const workspaceRef = useRef<string | null>(selectedWorkspaceId());
  useEffect(() => {
    const onSelection = () => {
      const next = selectedWorkspaceId();
      if (next === workspaceRef.current) return;
      workspaceRef.current = next;
      retry();
    };
    window.addEventListener(WORKSPACE_SELECTION_EVENT, onSelection);
    return () => window.removeEventListener(WORKSPACE_SELECTION_EVENT, onSelection);
  }, [retry]);

  if (demoActive) {
    return DEMO_MESSAGING_NUMBER_STATE;
  }

  if (!sessionReady || !userId) {
    return {
      ready: false,
      resolved: false,
      statusError: false,
      status: null,
      retry,
    };
  }

  if (!snapshot) {
    return {
      ready: true,
      resolved: false,
      statusError: false,
      status: null,
      retry,
    };
  }

  if (!snapshot.ok) {
    return {
      ready: true,
      resolved: true,
      statusError: true,
      status: null,
      retry,
    };
  }

  return {
    ready: true,
    resolved: true,
    statusError: false,
    status: snapshot.status,
    retry,
  };
}
