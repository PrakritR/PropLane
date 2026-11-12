"use client";

import { useEffect } from "react";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { cacheLandlordLegalName, fetchAndCacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { useWorkspaces } from "@/components/portal/workspace-provider";

/**
 * Keep the lease generator's landlord-name cache aligned with the server on portal load and when
 * the workspace changes. The name is the workspace's: its "Landlord on leases" setting, else its
 * OWNER's full name (on a PropLane-managed workspace, the client, never the signed-in staff).
 *
 * Nothing happens until the workspace selection has loaded. An unqualified read resolves the
 * ACCOUNT rung, and caching that as the active workspace's answer is how a lease came to print the
 * wrong landlord party in the first paint's round-trip. Until then the cache is a miss and
 * `leaseLandlordNameBlocker` refuses the send, which costs a regenerate instead.
 */
export function LandlordLegalNameCacheSync() {
  const activeWorkspaceId = useWorkspaces()?.active?.id ?? null;
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (isDemoModeActive()) {
      cacheLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME, activeWorkspaceId);
      return;
    }
    void fetchAndCacheLandlordLegalName(activeWorkspaceId);
  }, [activeWorkspaceId]);
  return null;
}
