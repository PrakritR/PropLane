"use client";

import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

type MessagingNumberLoadResult =
  | { ok: true; status: ManagerMessagingNumberStatus }
  | { ok: false; error: true };

let cachedUserId: string | null = null;
let cachedResult: MessagingNumberLoadResult | undefined;
let inflight: Promise<MessagingNumberLoadResult> | null = null;

const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

export function readManagerMessagingNumberStatusClient(
  userId: string | null,
): MessagingNumberLoadResult | undefined {
  if (!userId || cachedUserId !== userId) return undefined;
  return cachedResult;
}

export function subscribeManagerMessagingNumberStatusClient(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function loadManagerMessagingNumberStatusClient(
  userId: string,
): Promise<MessagingNumberLoadResult> {
  if (cachedUserId === userId && cachedResult !== undefined) {
    return Promise.resolve(cachedResult);
  }
  if (inflight) return inflight;

  inflight = fetch("/api/manager/messaging-number", {
    credentials: "include",
    cache: "no-store",
  })
    .then(async (res) => {
      if (!res.ok) throw new Error("Messaging status request failed.");
      const body = (await res.json()) as ManagerMessagingNumberStatus | null;
      const result: MessagingNumberLoadResult = {
        ok: true,
        status: (body ?? null) as ManagerMessagingNumberStatus,
      };
      cachedUserId = userId;
      cachedResult = result;
      notifyListeners();
      return result;
    })
    .catch(() => {
      const result: MessagingNumberLoadResult = { ok: false, error: true };
      cachedUserId = userId;
      cachedResult = result;
      notifyListeners();
      return result;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Test / sign-out hooks may clear the cache. */
export function resetManagerMessagingNumberStatusClientCache() {
  cachedUserId = null;
  cachedResult = undefined;
  inflight = null;
}
