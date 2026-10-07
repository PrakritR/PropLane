"use client";

import { useEffect } from "react";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalSession } from "@/hooks/use-portal-session";
import { notifyManagerApplicationsSynced, prefetchPortalData } from "@/lib/portal-data-store";
import { loadManagerSubscriptionTierClient } from "@/lib/manager-subscription-client";
import type { PortalKind } from "@/lib/portal-types";
import { runWhenIdle } from "@/lib/run-when-idle";

export function PortalDataPrefetch({ kind }: { kind: PortalKind }) {
  const session = usePortalSession();
  const { userId } = useManagerUserId();

  useEffect(() => {
    if (!session.ready) return;
    // Warm the shared caches after the page is interactive: the section's own
    // requests go first, and this fan-out (about fifteen routes) follows.
    return runWhenIdle(() => {
      void prefetchPortalData(kind, userId ?? session.userId)
        .then(() => {
          if (kind === "manager" || kind === "pro") {
            notifyManagerApplicationsSynced();
            void loadManagerSubscriptionTierClient();
          }
        })
        .catch(() => {
          /* prefetch is best-effort */
        });
    });
  }, [kind, session.ready, session.userId, userId]);

  return null;
}
