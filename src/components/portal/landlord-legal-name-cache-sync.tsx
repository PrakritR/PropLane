"use client";

import { useEffect } from "react";
import { CANONICAL_DEMO_MANAGER_NAME } from "@/lib/demo/demo-canonical-accounts";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { cacheLandlordLegalName, fetchAndCacheLandlordLegalName } from "@/lib/manager-landlord-profile";

/** Keep the lease generator's landlord-name cache aligned with the server on portal load. */
export function LandlordLegalNameCacheSync() {
  useEffect(() => {
    if (isDemoModeActive()) {
      cacheLandlordLegalName(CANONICAL_DEMO_MANAGER_NAME);
      return;
    }
    void fetchAndCacheLandlordLegalName();
  }, []);
  return null;
}
