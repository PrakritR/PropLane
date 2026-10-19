"use client";

import { useCallback, useEffect, useState } from "react";
import { useOwnerWorkspace } from "@/components/owner/owner-workspace";

export function formatOwnerUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents) / 100;
  const whole = Number.isInteger(abs);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function ownerMonthLabel(month: string, short = false): string {
  const [year, m] = month.split("-");
  const name = MONTHS[Number(m) - 1] ?? month;
  return short ? name.slice(0, 3) : `${name} ${year}`;
}

export type OwnerFetchState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

/**
 * `url` narrowed to the active workspace. The finances list is left alone: with no `workspace` it means "my managed workspaces",
 * and a call that already names one keeps it.
 */
export function withOwnerWorkspace(url: string, workspaceId: string | null): string {
  if (!workspaceId || !url.startsWith("/api/owner/")) return url;
  const path = url.split("?")[0]!;
  if (path === "/api/owner/finances" || path === "/api/owner/workspaces" || /[?&]workspace=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspaceId)}`;
}

/** One owner GET. Loading and error are first-class; the caller renders all three. */
export function useOwnerFetch<T>(rawUrl: string | null): OwnerFetchState<T> {
  const workspace = useOwnerWorkspace();
  // Inside the shell the first read waits for the workspace list, so nothing is fetched unscoped and then again scoped.
  const waiting = workspace?.loading ?? false;
  const url = rawUrl && !waiting ? withOwnerWorkspace(rawUrl, workspace?.activeId ?? null) : null;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(rawUrl));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) {
      setLoading(Boolean(rawUrl) && waiting);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as T & { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Request failed.");
        setData(body);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Request failed.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [url, tick, rawUrl, waiting]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, loading, error, reload };
}
