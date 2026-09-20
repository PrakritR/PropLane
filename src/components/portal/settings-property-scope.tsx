"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Workspace + property scope for Portfolio + Operations settings
 * (PLAN-0918-1500 phase A/B/C; PLAN-0920-0845 phase D added the workspace
 * rung and multi-property selection).
 *
 * One scope bar (`settings-scope-bar.tsx`) lives at the top of a settings
 * module. "" workspaceId is the account rung ("All workspaces"); an empty
 * `propertyIds` is the chosen workspace's default (or the account's, when
 * workspaceId is also ""); one or more `propertyIds` targets those houses'
 * own values. Panels read the scope through {@link useSettingsPropertyScope}
 * and add `?workspaceId=&propertyId=` to their fetches — `propertyId` stays
 * the FIRST selected id for the many panels that only ever show or write one
 * house at a time (see `propertyId`/`setPropertyId` below); a panel that
 * fans a write out across every selected house reads `propertyIds` instead.
 *
 * The hook is safe to call OUTSIDE a provider — it returns the account scope
 * (`workspaceId: ""`, `propertyIds: []`, no-op reporters) — so a panel
 * rendered standalone (a test, a gear sheet with no houses) still reads as
 * the account default.
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
  | "manager-tour-settings";

type ScopeContextValue = {
  /** "" = All workspaces (the account rung). */
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  /** Every selected house. Empty = the chosen workspace's (or account's) default. */
  propertyIds: string[];
  setPropertyIds: (ids: string[]) => void;
  /** @deprecated single-target convenience — the first selected house, or "". */
  propertyId: string;
  /** @deprecated single-target convenience — replaces the whole selection with one id (or clears it). */
  setPropertyId: (id: string) => void;
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
  workspaceId: "",
  setWorkspaceId: () => {},
  propertyIds: [],
  setPropertyIds: () => {},
  propertyId: "",
  setPropertyId: () => {},
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
  workspaceId,
  onWorkspaceIdChange,
  propertyIds,
  onPropertyIdsChange,
  options,
  children,
}: {
  workspaceId: string;
  onWorkspaceIdChange: (id: string) => void;
  propertyIds: string[];
  onPropertyIdsChange: (ids: string[]) => void;
  options: SettingsPropertyOption[];
  children: ReactNode;
}) {
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

  const setPropertyId = useCallback(
    (id: string) => onPropertyIdsChange(id ? [id] : []),
    [onPropertyIdsChange],
  );

  const value = useMemo<ScopeContextValue>(
    () => ({
      workspaceId,
      setWorkspaceId: onWorkspaceIdChange,
      propertyIds,
      setPropertyIds: onPropertyIdsChange,
      propertyId: propertyIds[0] ?? "",
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
    }),
    [
      workspaceId,
      onWorkspaceIdChange,
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
