"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { OwnerWorkspaceTile } from "@/lib/property-owner/projection";

const STORAGE_KEY = "proplane-owner-workspace";

export type OwnerWorkspaceContextValue = {
  workspaces: OwnerWorkspaceTile[];
  /** The workspace every owner read is narrowed to; null only while loading or when the owner has none. */
  activeId: string | null;
  active: OwnerWorkspaceTile | null;
  /** True until the workspace list answered: reads wait for it so they are never sent twice. */
  loading: boolean;
  select: (id: string) => void;
};

const OwnerWorkspaceContext = createContext<OwnerWorkspaceContextValue | null>(null);

export function useOwnerWorkspace(): OwnerWorkspaceContextValue | null {
  return useContext(OwnerWorkspaceContext);
}

/** The id to start on: the remembered one when it is still the owner's, else the first. */
export function pickOwnerWorkspace(workspaces: readonly OwnerWorkspaceTile[], remembered: string | null): string | null {
  if (workspaces.length === 0) return null;
  return workspaces.find((w) => w.id === remembered)?.id ?? workspaces[0]!.id;
}

function readRemembered(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Which of the owner's workspaces the portal is showing. The switcher in the rail changes it; every owner read adds it as
 * `?workspace=` (see `useOwnerFetch`) and the server narrows the membership to that one workspace or refuses (404).
 * Remembered per browser only; a stale value that is no longer theirs is ignored.
 */
export function OwnerWorkspaceProvider({ children, initial }: { children: ReactNode; initial?: OwnerWorkspaceTile[] }) {
  const [workspaces, setWorkspaces] = useState<OwnerWorkspaceTile[]>(initial ?? []);
  const [loading, setLoading] = useState(initial === undefined);
  const [activeId, setActiveId] = useState<string | null>(initial ? pickOwnerWorkspace(initial, null) : null);

  useEffect(() => {
    if (initial !== undefined) return;
    const controller = new AbortController();
    fetch("/api/owner/workspaces", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { workspaces?: OwnerWorkspaceTile[] };
        const list = res.ok && Array.isArray(body.workspaces) ? body.workspaces : [];
        setWorkspaces(list);
        setActiveId(pickOwnerWorkspace(list, readRemembered()));
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === "AbortError") return;
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [initial]);

  const select = useCallback((id: string) => {
    setActiveId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Remembering is a convenience; the switch itself already happened.
    }
  }, []);

  const value = useMemo<OwnerWorkspaceContextValue>(
    () => ({ workspaces, activeId, active: workspaces.find((w) => w.id === activeId) ?? null, loading, select }),
    [workspaces, activeId, loading, select],
  );
  return <OwnerWorkspaceContext.Provider value={value}>{children}</OwnerWorkspaceContext.Provider>;
}
