"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchCosignerSubmissionsForSignerAppId,
  readCosignerSubmissionsForSignerAppId,
  type CosignerSubmission,
} from "@/lib/cosigner-submissions-storage";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { isDemoModeActive } from "@/lib/demo/demo-session";

/**
 * Loads co-signer submissions keyed by normalized signer application id.
 * Fetches in parallel for the supplied signer ids (typically primary applications
 * with `hasCosigner === "yes"` visible in the current list).
 */
export function useCosignerSubmissionsMap(signerAppIds: string[], refreshKey = 0): Map<string, CosignerSubmission[]> {
  const [map, setMap] = useState<Map<string, CosignerSubmission[]>>(() => new Map());
  const ids = useMemo(() => {
    const normalized = signerAppIds
      .map((id) => normalizeApplicationAxisId(id).toUpperCase())
      .filter(Boolean);
    return [...new Set(normalized)].sort();
  }, [signerAppIds]);
  const idsKey = ids.join("\n");

  useEffect(() => {
    if (ids.length === 0) {
      setMap(new Map());
      return;
    }

    const demo = isDemoModeActive();
    if (demo) {
      const next = new Map<string, CosignerSubmission[]>();
      for (const id of ids) {
        next.set(id, readCosignerSubmissionsForSignerAppId(id));
      }
      setMap(next);
      return;
    }

    let cancelled = false;
    void Promise.all(
      ids.map(async (id) => {
        const rows = await fetchCosignerSubmissionsForSignerAppId(id);
        return [id, rows] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setMap(new Map(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [idsKey, refreshKey]);

  return map;
}
