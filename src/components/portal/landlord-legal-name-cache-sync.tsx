"use client";

import { useEffect } from "react";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { fetchAndCacheLandlordLegalName } from "@/lib/manager-landlord-profile";

/** Keep the lease generator's landlord-name cache aligned with the server on portal load. */
export function LandlordLegalNameCacheSync() {
  useEffect(() => {
    if (isDemoModeActive()) return;
    void fetchAndCacheLandlordLegalName();
  }, []);
  return null;
}
