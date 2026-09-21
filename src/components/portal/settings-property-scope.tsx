"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspaces } from "@/components/portal/workspace-provider";

/**
 * Workspace + property scope for Portfolio + Operations settings
 * (PLAN-0918-1500 phase A/B/C; PLAN-0920-0845 phase D added the workspace
 * rung and multi-property selection; the captain's later ask — "choose
 * which workspace AND which property, the dropdown should be a
 * multi-select box" — made the workspace rung multi-select too, spanning
 * several workspaces at once).
 *
 * One scope bar (`settings-scope-bar.tsx`) lives at the top of a settings
 * module. The manager's pick is a set of TARGETS (see {@link SettingsScopeTarget}):
 * each is either a whole workspace or one house. Nothing selected at all
 * means "the current active workspace" (today's default scope — see
 * `targets` below), not "every workspace."
 *
 * Panels read the scope through {@link useSettingsPropertyScope}. A panel
 * that has NOT been migrated to multi-target fan-out keeps working exactly
 * as it did before: `workspaceId`/`propertyId`/`propertyIds` are still
 * exposed as single-target convenience views (the FIRST resolved target),
 * so it silently degrades to "act on just the first selected target" rather
 * than breaking. A panel that fans a write out across every selected
 * target reads `targets` instead, and can use `fetchAcrossScopeTargets` /
 * `saveAcrossScopeTargets` below to do it without hand-rolling the
 * per-target request loop.
 *
 * The hook is safe to call OUTSIDE a provider — it returns the account scope
 * (no targets, no-op reporters) — so a panel rendered standalone (a test, a
 * gear sheet with no houses) still reads as the account default.
 */
export type SettingsPropertyOption = { id: string; label: string };

/** The same three-rung vocabulary the settings routes' `source` field uses (`scope-resolver.server.ts`). */
export type SettingsResolutionSource = "account" | "workspace" | "property";

/**
 * The settings API namespaces phase A/B scoped (`docs` in the phase D brief).
 * A fixed, well-known key per namespace lets a composite panel (Tasks,
 * Tours, Services, …) read back the source ITS OWN child rows already
 * fetched — `AutomationRuleRows` and `ManagerReminderRuleSettingsPanel` both
 * read `/api/portal/reminder-settings` and therefore report the same key —
 * without threading a prop through every one of them.
 */
export type SettingsSourceNamespace =
  | "reminder-settings"
  | "automated-messages"
  | "service-automation-settings"
  | "task-automation-settings"
  | "automation-settings"
  | "manager-application-settings"
  | "manager-tour-settings"
  /** PLAN-0920-0845 phase E: Incoming/Outgoing payment reminders now stack in the same
      Payments module at once, so they can no longer share the generic "reminder-settings"
      key without one overwriting the other's tag. */
  | "incoming-payment-reminders"
  | "outgoing-payment-reminders"
  /** Phase E: the Payment setup / Processing fee sections split out of one combined panel. */
  | "processing-fee-settings"
  /** Phase E: late fee amount + grace days live on each listing only — no workspace/account
      rung — so this namespace's source is always "property" once a scope resolves. */
  | "late-fee-settings";

/**
 * One save/read target: a whole workspace (`propertyId` omitted) or one
 * house inside a workspace. `workspaceId` is `""` only for the degenerate
 * "no workspace, no house" account-wide target (used when a manager has no
 * workspace at all yet).
 */
export type SettingsScopeTarget = { workspaceId: string; propertyId?: string };

type ScopeContextValue = {
  /** Every whole-workspace pick (the multi-select's checked group headers). */
  workspaceIds: string[];
  setWorkspaceIds: (ids: string[]) => void;
  /** @deprecated single-target convenience — the first resolved target's workspace, or "". */
  workspaceId: string;
  /** @deprecated single-target convenience — replaces the whole workspace selection with one id (or clears it). */
  setWorkspaceId: (id: string) => void;
  /** Every individually-picked house (may span workspaces not in `workspaceIds`). */
  propertyIds: string[];
  setPropertyIds: (ids: string[]) => void;
  /** @deprecated single-target convenience — the first selected house, or "". */
  propertyId: string;
  /** @deprecated single-target convenience — replaces the whole house selection with one id (or clears it). */
  setPropertyId: (id: string) => void;
  /** The canonical resolved target list a save/read fans out across. Never empty. */
  targets: SettingsScopeTarget[];
  options: SettingsPropertyOption[];
  /** A panel reports which houses have an override for its namespace(s). */
  reportOverriddenPropertyIds: (key: string, ids: string[]) => void;
  /** Union across every reporting namespace of the houses that have their own. */
  overriddenPropertyIds: string[];
  /** A panel reports the `source` its own GET resolved to, keyed by API namespace. */
  reportSource: (namespace: SettingsSourceNamespace, source: SettingsResolutionSource | null | undefined) => void;
  /** What each reporting namespace actually resolved to, for a composite panel's own group tags. */
  sources: Partial<Record<SettingsSourceNamespace, SettingsResolutionSource>>;
  /** Bumped when the manager asks to reset the selected house(s) to workspace defaults. */
  resetSignal: number;
  requestReset: () => void;
  /** True while any mounted panel is loading its settings for the current scope. */
  loading: boolean;
  reportLoading: (key: string, loading: boolean) => void;
};

const NOOP_SCOPE: ScopeContextValue = {
  workspaceIds: [],
  setWorkspaceIds: () => {},
  workspaceId: "",
  setWorkspaceId: () => {},
  propertyIds: [],
  setPropertyIds: () => {},
  propertyId: "",
  setPropertyId: () => {},
  targets: [{ workspaceId: "" }],
  options: [],
  reportOverriddenPropertyIds: () => {},
  overriddenPropertyIds: [],
  reportSource: () => {},
  sources: {},
  resetSignal: 0,
  requestReset: () => {},
  loading: false,
  reportLoading: () => {},
};

const SettingsPropertyScopeContext = createContext<ScopeContextValue>(NOOP_SCOPE);

export function useSettingsPropertyScope(): ScopeContextValue {
  return useContext(SettingsPropertyScopeContext);
}

export function SettingsPropertyScopeProvider({
  workspaceIds,
  onWorkspaceIdsChange,
  propertyIds,
  onPropertyIdsChange,
  options,
  children,
}: {
  workspaceIds: string[];
  onWorkspaceIdsChange: (ids: string[]) => void;
  propertyIds: string[];
  onPropertyIdsChange: (ids: string[]) => void;
  options: SettingsPropertyOption[];
  children: ReactNode;
}) {
  const workspaces = useWorkspaces();
  const overridesRef = useRef<Map<string, string[]>>(new Map());
  const [overriddenPropertyIds, setOverridden] = useState<string[]>([]);
  const loadingRef = useRef<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [sources, setSources] = useState<Partial<Record<SettingsSourceNamespace, SettingsResolutionSource>>>({});

  const reportOverriddenPropertyIds = useCallback((key: string, ids: string[]) => {
    overridesRef.current.set(key, ids);
    const merged = new Set<string>();
    for (const list of overridesRef.current.values()) for (const id of list) merged.add(id);
    setOverridden((prev) => {
      const next = [...merged];
      // Avoid a state churn loop when the same set is reported repeatedly.
      if (prev.length === next.length && next.every((id) => prev.includes(id))) return prev;
      return next;
    });
  }, []);

  const reportSource = useCallback(
    (namespace: SettingsSourceNamespace, source: SettingsResolutionSource | null | undefined) => {
      setSources((prev) => {
        if (!source) return prev;
        if (prev[namespace] === source) return prev;
        return { ...prev, [namespace]: source };
      });
    },
    [],
  );

  const reportLoading = useCallback((key: string, isLoading: boolean) => {
    loadingRef.current.set(key, isLoading);
    setLoading([...loadingRef.current.values()].some(Boolean));
  }, []);

  const requestReset = useCallback(() => setResetSignal((n) => n + 1), []);

  const setWorkspaceId = useCallback((id: string) => onWorkspaceIdsChange(id ? [id] : []), [onWorkspaceIdsChange]);
  const setPropertyId = useCallback((id: string) => onPropertyIdsChange(id ? [id] : []), [onPropertyIdsChange]);

  /**
   * The canonical target list. Nothing explicitly picked (fresh page load,
   * no `?workspace=`/`?property=`) resolves to the manager's CURRENT ACTIVE
   * workspace — today's default scope, per the captain's plan — not "every
   * workspace." A house pick that names no workspace of its own (a stale id,
   * or `options` from a caller that has not wired workspace ownership) still
   * resolves as a property-only target with `workspaceId: ""`; the server
   * route derives its workspace from the property row itself.
   */
  const targets = useMemo<SettingsScopeTarget[]>(() => {
    if (workspaceIds.length === 0 && propertyIds.length === 0) {
      const activeId = workspaces?.active?.id ?? "";
      return [{ workspaceId: activeId }];
    }
    const propertyOwner = new Map<string, string>();
    for (const workspace of workspaces?.workspaces ?? []) {
      for (const id of workspace.propertyIds) propertyOwner.set(id, workspace.id);
    }
    const wholeWorkspaceTargets = workspaceIds.map((id) => ({ workspaceId: id }));
    const explicitPropertyTargets = propertyIds
      .filter((id) => !workspaceIds.includes(propertyOwner.get(id) ?? "\u0000"))
      .map((id) => ({ workspaceId: propertyOwner.get(id) ?? "", propertyId: id }));
    const merged = [...wholeWorkspaceTargets, ...explicitPropertyTargets];
    return merged.length > 0 ? merged : [{ workspaceId: "" }];
  }, [workspaceIds, propertyIds, workspaces?.workspaces, workspaces?.active?.id]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      workspaceIds,
      setWorkspaceIds: onWorkspaceIdsChange,
      workspaceId: targets[0]?.workspaceId ?? "",
      setWorkspaceId,
      propertyIds,
      setPropertyIds: onPropertyIdsChange,
      propertyId: propertyIds[0] ?? "",
      setPropertyId,
      targets,
      options,
      reportOverriddenPropertyIds,
      overriddenPropertyIds,
      reportSource,
      sources,
      resetSignal,
      requestReset,
      loading,
      reportLoading,
    }),
    [
      workspaceIds,
      onWorkspaceIdsChange,
      targets,
      setWorkspaceId,
      propertyIds,
      onPropertyIdsChange,
      setPropertyId,
      options,
      reportOverriddenPropertyIds,
      overriddenPropertyIds,
      reportSource,
      sources,
      resetSignal,
      requestReset,
      loading,
      reportLoading,
    ],
  );

  return (
    <SettingsPropertyScopeContext.Provider value={value}>{children}</SettingsPropertyScopeContext.Provider>
  );
}

/** Query-string suffix (`?workspaceId=&propertyId=`, or `""`) for one scope target — the shape every scoped route already accepts. */
export function scopeTargetQuery(target: SettingsScopeTarget): string {
  const params = new URLSearchParams();
  if (target.workspaceId) params.set("workspaceId", target.workspaceId);
  if (target.propertyId) params.set("propertyId", target.propertyId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Body fields (`{ workspaceId?, propertyId? }`) for one scope target — merge into a save's JSON body. */
export function scopeTargetBody(target: SettingsScopeTarget): Record<string, string> {
  const body: Record<string, string> = {};
  if (target.workspaceId) body.workspaceId = target.workspaceId;
  if (target.propertyId) body.propertyId = target.propertyId;
  return body;
}

export type FetchAcrossScopeTargetsResult<T> = {
  /** The first target's resolved value — what a single-target panel would have shown. */
  value: T;
  /** True when at least two targets' values are not deep-equal — render "Mixed" instead of `value`. */
  mixed: boolean;
  perTarget: { target: SettingsScopeTarget; value: T }[];
};

/**
 * GET the same endpoint once per selected target (client fan-out — no
 * server route changes; every existing scoped route already re-derives its
 * own authorization from ITS OWN `workspaceId`/`propertyId`, so one request
 * per target keeps that per-target authorization intact). `pickValue`
 * extracts the comparable settings value from each response body — compare
 * only that, not the whole payload (a `source`/`overriddenPropertyIds` field
 * legitimately differs target to target without meaning the SETTING itself
 * is mixed).
 */
export async function fetchAcrossScopeTargets<T>(
  targets: readonly SettingsScopeTarget[],
  buildUrl: (query: string) => string,
  pickValue: (body: unknown) => T,
  opts?: {
    init?: RequestInit;
    /** Compare two picked values for the "mixed" check — default is deep JSON equality. Use this when `T` carries fields (e.g. `source`) that legitimately differ per target without the SETTING itself being mixed. */
    isEqual?: (a: T, b: T) => boolean;
  },
): Promise<FetchAcrossScopeTargetsResult<T>> {
  const perTarget = await Promise.all(
    targets.map(async (target) => {
      const res = await fetch(buildUrl(scopeTargetQuery(target)), {
        credentials: "include",
        cache: "no-store",
        ...opts?.init,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string })?.error || "Could not load settings.");
      return { target, value: pickValue(body) };
    }),
  );
  const first = perTarget[0]?.value as T;
  const isEqual = opts?.isEqual ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  const mixed = perTarget.some((entry) => !isEqual(entry.value, first));
  return { value: first, mixed, perTarget };
}

export type SaveAcrossScopeTargetsResult = {
  ok: boolean;
  /** Targets whose save failed, with the error message the route returned. */
  failed: { target: SettingsScopeTarget; error: string }[];
};

/**
 * POST/PUT the same body to every selected target (one request per target,
 * each re-authorized server-side on its own `workspaceId`/`propertyId` —
 * never trust a target list from the client as authorization by itself).
 * `buildBody` receives the base body plus that target's own
 * `{workspaceId?, propertyId?}` fields merged in.
 */
export async function saveAcrossScopeTargets(
  targets: readonly SettingsScopeTarget[],
  url: string,
  method: "POST" | "PUT" | "PATCH",
  baseBody: Record<string, unknown>,
): Promise<SaveAcrossScopeTargetsResult> {
  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        const res = await fetch(url, {
          method,
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...baseBody, ...scopeTargetBody(target) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { target, error: (body as { error?: string })?.error || "Could not save." };
        return null;
      } catch (error) {
        return { target, error: error instanceof Error ? error.message : "Could not save." };
      }
    }),
  );
  const failed = results.filter((r): r is { target: SettingsScopeTarget; error: string } => r !== null);
  return { ok: failed.length === 0, failed };
}
