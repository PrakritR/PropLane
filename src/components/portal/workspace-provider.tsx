"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { PortalWorkspace, WorkspacePayload, WorkspacePlan } from "@/lib/workspaces/types";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { managerPropertyRowsForStage } from "@/lib/demo-admin-property-inventory";
import { resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { useManagerUserId } from "@/hooks/use-manager-user-id";

export type WorkspaceContextValue = {
  workspaces: PortalWorkspace[];
  active: PortalWorkspace | null;
  plan: WorkspacePlan | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  mutate: (body: Record<string, unknown>) => Promise<void>;
  /** Switch workspace. Default destination is the dashboard (exits property scope). Pass `href` to land elsewhere, or `false` to stay. */
  select: (id: string, opts?: { href?: string | false }) => Promise<void>;
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
  /**
   * Membership is the only test a row passes to be shown in a workspace, and
   * membership is read ONCE here. A property created in this session — a draft
   * saved from the editor, a listing just published — therefore belonged to no
   * workspace the client knew about until the next full page load: the Properties
   * list stayed empty after "Save & exit", and the home the manager had just made
   * read as missing. When the local property store announces a change that
   * includes an id no workspace holds, read the workspaces again. Each unknown id
   * triggers at most one read, so a house this account is only assigned to (never
   * a member of any owned workspace) cannot turn every event into a request.
   */
  const payloadRef = useRef(payload);
  useEffect(() => {
    payloadRef.current = payload;
  }, [payload]);
  const refreshedForRef = useRef(new Set<string>());
  const { userId } = useManagerUserId();
  const scopeUserId = resolveManagerScopeUserId(userId);
  useEffect(() => {
    if (typeof window === "undefined" || !scopeUserId) return;
    let inFlight = false;
    const onPipeline = () => {
      if (inFlight) return;
      const known = new Set(payloadRef.current.workspaces.flatMap((w) => w.propertyIds));
      // Listed, unlisted and drafts — every bucket the Properties list draws from.
      const unknown = managerPropertyRowsForStage([2, 3, 5], scopeUserId)
        .map((row) => row.listingId?.trim() || row.adminRefId.trim())
        .filter((id) => id && !known.has(id) && !refreshedForRef.current.has(id));
      const unlabeledKey = "__unlabeled__";
      const unlabeled =
        !refreshedForRef.current.has(unlabeledKey) &&
        payloadRef.current.workspaces.some((workspace) =>
          workspace.propertyIds.some((raw) => {
            const id = raw.trim();
            if (!id) return false;
            return !String(workspace.propertyLabels?.[id] ?? "").trim();
          }),
        );
      if (unknown.length === 0 && !unlabeled) return;
      for (const id of unknown) refreshedForRef.current.add(id);
      if (unlabeled) refreshedForRef.current.add(unlabeledKey);
      inFlight = true;
      void refresh().finally(() => {
        inFlight = false;
      });
    };
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onPipeline);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, onPipeline);
  }, [refresh, scopeUserId]);
  const mutate = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/workspaces", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not update workspace.");
    await refresh();
  }, [refresh]);
  const select = useCallback(async (id: string, opts?: { href?: string | false }) => {
    await mutate({ action: "select", id });
    if (opts?.href === false) {
      router.refresh();
      return;
    }
    // A switch explicitly exits property scope unless a caller names the next page
    // (Settings Team, Operations Vendors).
    router.push(opts?.href ?? "/portal/dashboard");
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
