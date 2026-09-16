"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { PortalSettingsScopeTag } from "@/components/portal/portal-settings-ui";

/**
 * Per-property scope for Operations settings (PLAN-0916-1040).
 *
 * One picker at the top of the pane sets which house the sections below apply
 * to; "" is the workspace default ("All properties"). The panels read the scope
 * through {@link useSettingsPropertyScope} and add `?propertyId=` to their
 * fetches. The picker never appears when the workspace has a single property.
 *
 * The hook is safe to call OUTSIDE a provider — it returns the workspace scope
 * (`propertyId: ""`, no-op reporters) — so a panel mounted by the per-tab gear
 * modal, which has no scope bar, behaves exactly as it did before.
 */
export type SettingsPropertyOption = { id: string; label: string };

type ScopeContextValue = {
  /** "" = All properties (workspace default). */
  propertyId: string;
  setPropertyId: (id: string) => void;
  options: SettingsPropertyOption[];
  /** A panel reports which houses have an override for its namespace(s). */
  reportOverriddenPropertyIds: (key: string, ids: string[]) => void;
  /** Union across every reporting namespace of the houses that have their own. */
  overriddenPropertyIds: string[];
  /** Bumped when the manager asks to reset the selected house to workspace defaults. */
  resetSignal: number;
  requestReset: () => void;
  /** True while any mounted panel is loading its settings for the current scope. */
  loading: boolean;
  reportLoading: (key: string, loading: boolean) => void;
};

const NOOP_SCOPE: ScopeContextValue = {
  propertyId: "",
  setPropertyId: () => {},
  options: [],
  reportOverriddenPropertyIds: () => {},
  overriddenPropertyIds: [],
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
  propertyId,
  onPropertyIdChange,
  options,
  children,
}: {
  propertyId: string;
  onPropertyIdChange: (id: string) => void;
  options: SettingsPropertyOption[];
  children: ReactNode;
}) {
  const overridesRef = useRef<Map<string, string[]>>(new Map());
  const [overriddenPropertyIds, setOverridden] = useState<string[]>([]);
  const loadingRef = useRef<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);

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

  const reportLoading = useCallback((key: string, isLoading: boolean) => {
    loadingRef.current.set(key, isLoading);
    setLoading([...loadingRef.current.values()].some(Boolean));
  }, []);

  const requestReset = useCallback(() => setResetSignal((n) => n + 1), []);

  const value = useMemo<ScopeContextValue>(
    () => ({
      propertyId,
      setPropertyId: onPropertyIdChange,
      options,
      reportOverriddenPropertyIds,
      overriddenPropertyIds,
      resetSignal,
      requestReset,
      loading,
      reportLoading,
    }),
    [
      propertyId,
      onPropertyIdChange,
      options,
      reportOverriddenPropertyIds,
      overriddenPropertyIds,
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

const ALL_PROPERTIES = "__all__";

/**
 * The scope bar — one property picker pinned at the top of an Operations pane.
 * Shows "N houses have their own" on the workspace view, "Uses workspace
 * defaults" on an un-customized house, and "Reset to workspace default" on a
 * customized house. Renders nothing when the workspace has one property.
 */
export function SettingsPropertyScopeBar() {
  const scope = useSettingsPropertyScope();
  const { options, propertyId, overriddenPropertyIds } = scope;

  if (options.length <= 1) return null;

  const overridden = new Set(overriddenPropertyIds);
  const overriddenOptions = options.filter((o) => overridden.has(o.id));
  const right =
    propertyId === "" ? (
      overriddenOptions.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <PortalSettingsScopeTag variant="muted">
            {overriddenOptions.length === 1
              ? "1 house has its own"
              : `${overriddenOptions.length} houses have their own`}
          </PortalSettingsScopeTag>
          {overriddenOptions.map((o) => (
            <PortalSettingsScopeTag key={o.id} variant="muted">
              {o.label}
            </PortalSettingsScopeTag>
          ))}
        </span>
      ) : null
    ) : overridden.has(propertyId) ? (
      <button
        type="button"
        onClick={scope.requestReset}
        disabled={scope.loading}
        data-attr="settings-property-scope-reset"
        className="text-[13px] font-semibold text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
      >
        Reset to workspace default
      </button>
    ) : (
      <PortalSettingsScopeTag variant="muted">Uses workspace defaults</PortalSettingsScopeTag>
    );

  return (
    <div className="sticky top-0 z-[3] mb-5 flex flex-col gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2.5">
        <span className="text-[13px] font-semibold text-foreground">Property</span>
        {/* Pill on desktop (matches Finances); a full-width field on a phone. */}
        <span className="hidden sm:inline-flex">
          <FieldSingleSelect
            label="Property"
            value={propertyId || ALL_PROPERTIES}
            onChange={(next) => scope.setPropertyId(next === ALL_PROPERTIES ? "" : next)}
            options={[
              { value: ALL_PROPERTIES, label: "All properties" },
              ...options.map((o) => ({ value: o.id, label: o.label })),
            ]}
            disabled={scope.loading}
            dataAttr="settings-property-scope"
            variant="pill"
            triggerClassName={`${FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} max-w-[15rem]`}
          />
        </span>
      </div>
      <span className="sm:hidden">
        <FieldSingleSelect
          label="Property"
          hideLabel
          value={propertyId || ALL_PROPERTIES}
          onChange={(next) => scope.setPropertyId(next === ALL_PROPERTIES ? "" : next)}
          options={[
            { value: ALL_PROPERTIES, label: "All properties" },
            ...options.map((o) => ({ value: o.id, label: o.label })),
          ]}
          disabled={scope.loading}
          dataAttr="settings-property-scope-mobile"
          wrapperClassName="w-full"
        />
      </span>
      {right ? <div className="flex items-center">{right}</div> : null}
    </div>
  );
}

/**
 * The section-header echo of the current scope — replaces the static
 * "All properties" tag on an Operations section so a header always names the
 * house whose settings it is showing.
 */
export function SettingsPropertyScopeEcho() {
  const scope = useSettingsPropertyScope();
  if (scope.options.length <= 1) {
    // A single-property workspace keeps the plain workspace tag.
    return <PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>;
  }
  if (!scope.propertyId) return <PortalSettingsScopeTag>All properties</PortalSettingsScopeTag>;
  const label = scope.options.find((o) => o.id === scope.propertyId)?.label ?? "This property";
  const inherited = !scope.overriddenPropertyIds.includes(scope.propertyId);
  return (
    <PortalSettingsScopeTag variant={inherited ? "muted" : "default"}>{label}</PortalSettingsScopeTag>
  );
}
