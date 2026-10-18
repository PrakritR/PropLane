"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminOversightUrl } from "@/lib/auth/admin-oversight.client";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { invalidateSharedGets, sharedGet, writeThroughFetch } from "@/lib/shared-get-cache";
import type { DispatchRule, DispatchRuleInput } from "@/lib/vendor-dispatch/rules";
import {
  pickRunForSource,
  type DispatchRunAction,
  type DispatchRunView,
} from "@/lib/vendor-dispatch/runs-view";

/** Browser side of vendor dispatch (vendor-dispatch-1018): rules, runs and run actions. */
const RULES_URL = "/api/portal/vendor-dispatch/rules";
const RUNS_URL = "/api/portal/vendor-dispatch/runs";
const ALL_DISPATCH = "/api/portal/vendor-dispatch/";

export const DISPATCH_CHANGED_EVENT = "axis:vendor-dispatch";

function announceChange() {
  invalidateSharedGets(ALL_DISPATCH);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DISPATCH_CHANGED_EVENT));
}

export type DispatchRulesState = {
  rules: DispatchRule[];
  /** Houses a rule may name in this workspace. Empty until loaded. */
  workspacePropertyIds: string[];
  loading: boolean;
  error: boolean;
  reload: () => void;
};

export function useDispatchRules(enabled = true): DispatchRulesState {
  const [rules, setRules] = useState<DispatchRule[]>([]);
  const [workspacePropertyIds, setHouses] = useState<string[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const generation = useRef(0);

  const load = useCallback(
    async (force: boolean) => {
      if (!enabled || isDemoModeActive()) {
        setLoading(false);
        return;
      }
      const mine = ++generation.current;
      const result = await sharedGet(adminOversightUrl(RULES_URL), { force });
      if (mine !== generation.current) return;
      if (!result.ok) {
        setError(true);
        setLoading(false);
        return;
      }
      const data = result.data as { rules?: DispatchRule[]; workspacePropertyIds?: string[] } | null;
      setRules(Array.isArray(data?.rules) ? data!.rules! : []);
      setHouses(Array.isArray(data?.workspacePropertyIds) ? data!.workspacePropertyIds! : []);
      setError(false);
      setLoading(false);
    },
    [enabled],
  );

  useEffect(() => {
    void load(false);
    const onChange = () => void load(true);
    window.addEventListener(DISPATCH_CHANGED_EVENT, onChange);
    return () => {
      generation.current += 1;
      window.removeEventListener(DISPATCH_CHANGED_EVENT, onChange);
    };
  }, [load]);

  return { rules, workspacePropertyIds, loading, error, reload: () => void load(true) };
}

export type SaveResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

export async function saveDispatchRule(
  ruleId: string | null,
  input: Partial<DispatchRuleInput>,
): Promise<SaveResult<DispatchRule>> {
  try {
    const res = await writeThroughFetch(
      ruleId ? `${RULES_URL}/${encodeURIComponent(ruleId)}` : RULES_URL,
      {
        method: ruleId ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      { invalidatePrefix: ALL_DISPATCH },
    );
    if (!res.ok) return { ok: false, error: await readError(res, "Could not save the rule.") };
    const body = (await res.json()) as { rule: DispatchRule };
    announceChange();
    return { ok: true, value: body.rule };
  } catch {
    return { ok: false, error: "Could not save the rule." };
  }
}

export async function deleteDispatchRuleClient(ruleId: string): Promise<SaveResult> {
  try {
    const res = await writeThroughFetch(
      `${RULES_URL}/${encodeURIComponent(ruleId)}`,
      { method: "DELETE", credentials: "include" },
      { invalidatePrefix: ALL_DISPATCH },
    );
    if (!res.ok) return { ok: false, error: await readError(res, "Could not delete the rule.") };
    announceChange();
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "Could not delete the rule." };
  }
}

export function runsUrl(query: { sourceType?: string; sourceId?: string; status?: string }): string {
  const params = new URLSearchParams();
  if (query.sourceType) params.set("sourceType", query.sourceType);
  if (query.sourceId) params.set("sourceId", query.sourceId);
  if (query.status) params.set("status", query.status);
  const text = params.toString();
  return adminOversightUrl(text ? `${RUNS_URL}?${text}` : RUNS_URL);
}

export type DispatchRunsState = {
  runs: DispatchRunView[];
  loading: boolean;
  reload: () => void;
};

/** Runs for one source (a service) or, with `status`, for the whole workspace. One request per URL (`sharedGet`). */
export function useDispatchRuns(
  query: { sourceType?: string; sourceId?: string; status?: string },
  enabled = true,
): DispatchRunsState {
  const [runs, setRuns] = useState<DispatchRunView[]>([]);
  const [loading, setLoading] = useState(enabled);
  const generation = useRef(0);
  const url = runsUrl(query);

  const load = useCallback(
    async (force: boolean) => {
      if (!enabled || isDemoModeActive()) {
        setLoading(false);
        return;
      }
      const mine = ++generation.current;
      const result = await sharedGet(url, { force });
      if (mine !== generation.current) return;
      if (result.ok) {
        const data = result.data as { runs?: DispatchRunView[] } | null;
        setRuns(Array.isArray(data?.runs) ? data!.runs! : []);
      } else {
        // 401/403/503: the viewer has no dispatch here. Show nothing rather than an error.
        setRuns([]);
      }
      setLoading(false);
    },
    [enabled, url],
  );

  useEffect(() => {
    void load(false);
    const onChange = () => void load(true);
    window.addEventListener(DISPATCH_CHANGED_EVENT, onChange);
    return () => {
      generation.current += 1;
      window.removeEventListener(DISPATCH_CHANGED_EVENT, onChange);
    };
  }, [load]);

  return { runs, loading, reload: () => void load(true) };
}

/** The one run a service record shows: the open one, else the newest. */
export function runForSource(runs: readonly DispatchRunView[]): DispatchRunView | null {
  return pickRunForSource(runs);
}

export async function postDispatchRunAction(
  runId: string,
  action: DispatchRunAction,
  position?: number,
): Promise<SaveResult<string>> {
  try {
    const res = await writeThroughFetch(
      `${RUNS_URL}/${encodeURIComponent(runId)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(position == null ? { action } : { action, position }),
      },
      { invalidatePrefix: ALL_DISPATCH },
    );
    if (!res.ok) {
      announceChange();
      return { ok: false, error: await readError(res, "Could not do that.") };
    }
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    announceChange();
    return { ok: true, value: body?.status ?? "" };
  } catch {
    return { ok: false, error: "Could not do that." };
  }
}
