"use client";

import { useCallback, useEffect, useState } from "react";
import type { MockProperty } from "@/data/types";
import {
  isPropertyActiveForLeads,
  loadPublicExtraListingsFromServer,
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsPublic,
} from "@/lib/demo-property-pipeline";
import { filterSandboxFromPublicCatalog } from "@/lib/public-sandbox-listings";
import { isProductionPublicSite } from "@/lib/public-demo-access";
import { syncPublicApprovedApplicationsFromServer } from "@/lib/manager-applications-storage";

function readActivePublicListings(): MockProperty[] {
  const listings = readExtraListingsPublic().filter(isPropertyActiveForLeads);
  return filterSandboxFromPublicCatalog(listings, { production: isProductionPublicSite() });
}

export function usePublicListings() {
  // Always start empty/loading on both server and the client's first paint — reading localStorage
  // synchronously in the initializer would make the client's very first render diverge from the
  // (always-empty) SSR markup and trigger a hydration mismatch. The cache read below happens in an
  // effect, i.e. after hydration, so it can never disagree with what the server sent.
  const [listings, setListings] = useState<MockProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [occupancyReady, setOccupancyReady] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoading(true);
    setAttempt((n) => n + 1);
  }, []);

  const refreshFromCache = useCallback(() => {
    setListings(readActivePublicListings());
  }, []);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;
      refreshFromCache();
      setLoading(readActivePublicListings().length === 0);
      setError(false);
    });

    void Promise.all([
      loadPublicExtraListingsFromServer(),
      syncPublicApprovedApplicationsFromServer({ force: true }),
    ])
      .then(([loaded]) => {
        if (cancelled) return;
        const active = loaded.filter(isPropertyActiveForLeads);
        setListings(filterSandboxFromPublicCatalog(active, { production: isProductionPublicSite() }));
        setOccupancyReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const on = () => refreshFromCache();
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => {
      cancelled = true;
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
    };
  }, [refreshFromCache, attempt]);

  return { listings, loading, occupancyReady, error, retry };
}
