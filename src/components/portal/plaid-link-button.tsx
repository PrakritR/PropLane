"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from "react-plaid-link";

export type PlaidLinkSuccess = { publicToken: string; accountId: string | null; metadata: PlaidLinkOnSuccessMetadata };

/** Mounted only once a link token exists, so Link's script loads on demand and opens once. */
function OpenPlaidLink({
  token,
  onSuccess,
  onDone,
}: {
  token: string;
  onSuccess: (result: PlaidLinkSuccess) => void;
  onDone: () => void;
}) {
  const opened = useRef(false);
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: (publicToken, metadata) => {
      if (!publicToken) return;
      onSuccess({ publicToken, accountId: metadata.accounts?.[0]?.id ?? null, metadata });
    },
    onExit: () => onDone(),
  });
  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [ready, open]);
  return null;
}

/**
 * Plaid Link launcher for any purpose. `children` renders the control (an icon action or a
 * button) and receives `start`, which mints a link token for the session user, then opens Link.
 * `itemId` opens update mode (Reconnect).
 */
export function PlaidLinkLauncher({
  purpose,
  itemId,
  endpoint = "/api/plaid/link-token",
  linkBody,
  onSuccess,
  onError,
  children,
}: {
  purpose: "bank_feed" | "resident_pay" | "income";
  itemId?: string;
  /** A purpose with its own link-token route (the applicant income check) names it here. */
  endpoint?: string;
  /** Extra fields for that route's body (the listing id). */
  linkBody?: Record<string, unknown>;
  onSuccess: (result: PlaidLinkSuccess) => void | Promise<void>;
  onError?: (message: string) => void;
  children: (args: { start: () => Promise<void>; busy: boolean }) => ReactNode;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const linkBodyKey = JSON.stringify(linkBody ?? {});
  const start = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose, ...(itemId ? { itemId } : {}), ...(JSON.parse(linkBodyKey) as Record<string, unknown>) }),
      });
      const data = (await res.json()) as { linkToken?: string; error?: string };
      if (!res.ok || !data.linkToken) throw new Error(data.error ?? "Couldn't reach your bank.");
      setToken(data.linkToken);
    } catch (e) {
      setBusy(false);
      onError?.(e instanceof Error ? e.message : "Couldn't reach your bank.");
    }
  }, [purpose, itemId, endpoint, linkBodyKey, onError]);

  return (
    <>
      {children({ start, busy })}
      {token ? (
        <OpenPlaidLink
          token={token}
          onSuccess={async (result) => {
            try {
              await onSuccess(result);
            } finally {
              setToken(null);
              setBusy(false);
            }
          }}
          onDone={() => {
            setToken(null);
            setBusy(false);
          }}
        />
      ) : null}
    </>
  );
}
