"use client";

import { useEffect, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

/**
 * A service's completion photos as displayable URLs: signed URLs for the private-bucket paths
 * (`completionPhotoPaths`) plus any legacy inline `completionPhotoDataUrls` already on the row.
 *
 * The signed URLs expire, and the route says when (`expiresInSeconds`, its own TTL), so an open
 * record re-signs ahead of that instead of turning into broken images.
 */
export function useCompletionPhotoUrls(row: Pick<DemoManagerWorkOrderRow, "id" | "completionPhotoPaths" | "completionPhotoDataUrls"> | null | undefined): string[] {
  const [signed, setSigned] = useState<{ id: string; urls: string[] } | null>(null);
  const id = row?.id ?? "";
  const hasPaths = (row?.completionPhotoPaths?.length ?? 0) > 0;
  const pathKey = (row?.completionPhotoPaths ?? []).join("|");

  useEffect(() => {
    if (!id || !hasPaths) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      void fetch(`/api/portal/work-orders/completion-photos?workOrderId=${encodeURIComponent(id)}`, { credentials: "include" })
        .then((res) => (res.ok ? res.json() : { urls: [] }))
        .then((data: { urls?: string[]; expiresInSeconds?: number }) => {
          if (cancelled) return;
          setSigned({ id, urls: data.urls ?? [] });
          const ttl = Number(data.expiresInSeconds);
          if (Number.isFinite(ttl) && ttl > 30) {
            timer = setTimeout(load, Math.round(ttl * 0.8) * 1000);
          }
        })
        .catch(() => undefined);
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, hasPaths, pathKey]);

  const fromPaths = signed && signed.id === id ? signed.urls : [];
  return [...fromPaths, ...(row?.completionPhotoDataUrls ?? [])];
}
