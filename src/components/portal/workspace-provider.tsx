"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { PortalWorkspace, WorkspacePayload, WorkspacePlan } from "@/lib/workspaces/types";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";

export type WorkspaceContextValue = {
  workspaces: PortalWorkspace[];
  active: PortalWorkspace | null;
  plan: WorkspacePlan | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  mutate: (body: Record<string, unknown>) => Promise<void>;
  select: (id: string) => Promise<void>;
};
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspaces() { return useContext(WorkspaceContext); }

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [payload, setPayload] = useState<WorkspacePayload>({ workspaces: [], activeWorkspaceId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/workspaces", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load workspaces.");
      setPayload(data);
      setWorkspaceSelection(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load workspaces.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); return () => setWorkspaceSelection(null); }, [refresh]);
  const mutate = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/workspaces", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not update workspace.");
    await refresh();
  }, [refresh]);
  const select = useCallback(async (id: string) => {
    await mutate({ action: "select", id });
    // A switch explicitly exits property scope; local page filters reset with it.
    router.push("/portal/dashboard");
    router.refresh();
  }, [mutate, router]);
  const active = payload.workspaces.find((w) => w.id === payload.activeWorkspaceId) ?? null;
  return (
    <WorkspaceContext.Provider value={{ workspaces: payload.workspaces, active, plan: payload.plan ?? null, error, loading, refresh, mutate, select }}>
      {error ? <div role="alert" className="flex items-center gap-2 border-b border-border bg-card px-3 py-2 text-sm">
        <span>{error}</span><Button variant="ghost" onClick={refresh}>Retry</Button>
      </div> : null}
      <Fragment key={payload.activeWorkspaceId}>{children}</Fragment>
    </WorkspaceContext.Provider>
  );
}
