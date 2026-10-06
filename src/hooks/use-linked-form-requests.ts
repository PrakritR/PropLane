"use client";

import { useCallback, useEffect, useState } from "react";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";
import { fetchLinkedFormsForApplication } from "@/lib/linked-form-requests-client";

/** The forms owed on one application, for the manager's record and the approve confirm. Empty until loaded. */
export function useLinkedFormRequests(applicationId: string | null | undefined) {
  const [requests, setRequests] = useState<LinkedFormRequestView[]>([]);
  const [loading, setLoading] = useState(Boolean(applicationId));

  const reload = useCallback(async () => {
    if (!applicationId) {
      setRequests([]);
      setLoading(false);
      return [] as LinkedFormRequestView[];
    }
    const next = await fetchLinkedFormsForApplication(applicationId);
    setRequests(next);
    setLoading(false);
    return next;
  }, [applicationId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!applicationId) return;
      const next = await fetchLinkedFormsForApplication(applicationId);
      if (cancelled) return;
      setRequests(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  return { requests, loading, reload };
}
