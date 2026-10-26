"use client";

import { useEffect, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

/**
 * A service's completion photos as displayable URLs: signed URLs for the private-bucket paths
 * (`completionPhotoPaths`) plus any legacy inline `completionPhotoDataUrls` already on the row.
 */
export function useCompletionPhotoUrls(row: Pick<DemoManagerWorkOrderRow, "id" | "completionPhotoPaths" | "completionPhotoDataUrls"> | null | undefined): string[] {
  const [signed, setSigned] = useState<{ id: string; urls: string[] } | null>(null);
  const id = row?.id ?? "";
  const hasPaths = (row?.completionPhotoPaths?.length ?? 0) > 0;
  const pathKey = (row?.completionPhotoPaths ?? []).join("|");

  useEffect(() => {
    if (!id || !hasPaths) return;
    let cancelled = false;
    void fetch(`/api/portal/work-orders/completion-photos?workOrderId=${encodeURIComponent(id)}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { urls: [] }))
      .then((data: { urls?: string[] }) => {
        if (!cancelled) setSigned({ id, urls: data.urls ?? [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, hasPaths, pathKey]);

  const fromPaths = signed && signed.id === id ? signed.urls : [];
  return [...fromPaths, ...(row?.completionPhotoDataUrls ?? [])];
}
