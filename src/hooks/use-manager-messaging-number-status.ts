"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
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

export function useManagerMessagingNumberStatus(): ManagerMessagingNumberStatusState {
  const { userId, ready: sessionReady } = useManagerUserId();
  const [attempt, setAttempt] = useState(0);

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
    if (!sessionReady || !userId) return;
    void loadManagerMessagingNumberStatusClient(userId);
  }, [attempt, sessionReady, userId]);

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
