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
 * A sticky bar at the top of a pane (when the workspace has houses) and the
 * compact picker in each section header both set which house the sections apply
 * to; "" is the workspace default ("All properties"). The panels read the scope
 * through {@link useSettingsPropertyScope} and add `?propertyId=` to their
 * fetches.
 *
 * The hook is safe to call OUTSIDE a provider — it returns the workspace scope
 * (`propertyId: ""`, no-op reporters) — so a panel without houses still reads
 * as the workspace default. Gear sheets that pass `propertyOptions` wrap this
 * provider the same way the Settings hub does.
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

function SettingsPropertyScopePicker({
  compact,
  dataAttr,
  fullWidth,
}: {
  compact?: boolean;
  dataAttr: string;
  fullWidth?: boolean;
}) {
  const scope = useSettingsPropertyScope();
  const pickerOptions = [
    { value: ALL_PROPERTIES, label: "All properties" },
    ...scope.options.map((o) => ({ value: o.id, label: o.label })),
  ];
  const selectAllFooter = (close: () => void) => (
    <button
      type="button"
      data-attr="settings-property-scope-select-all"
      className="w-full rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold text-primary hover:bg-accent/60"
      onClick={() => {
        scope.setPropertyId("");
        close();
      }}
    >
      Select all
    </button>
  );

  return (
    <FieldSingleSelect
      label="Property"
      hideLabel
      value={scope.propertyId || ALL_PROPERTIES}
      onChange={(next) => scope.setPropertyId(next === ALL_PROPERTIES ? "" : next)}
      options={pickerOptions}
      disabled={scope.loading}
      dataAttr={dataAttr}
      variant="pill"
      triggerClassName={`${FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} max-w-[15rem]`}
      wrapperClassName={fullWidth ? "w-full" : compact ? "max-w-[15rem]" : undefined}
      menuFooter={selectAllFooter}
    />
  );
}

/**
 * The scope bar — one property picker pinned at the top of a settings pane.
 * Always visible when the workspace has houses. "" is All properties.
 * "Select all" in the menu is the same pick as All properties.
 */
export function SettingsPropertyScopeBar() {
  const scope = useSettingsPropertyScope();
  const { options, propertyId, overriddenPropertyIds } = scope;

  if (options.length === 0) return null;

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
        <span className="hidden sm:inline-flex">
          <SettingsPropertyScopePicker dataAttr="settings-property-scope" />
        </span>
      </div>
      <span className="sm:hidden">
        <SettingsPropertyScopePicker dataAttr="settings-property-scope-mobile" fullWidth />
      </span>
      {right ? <div className="flex items-center">{right}</div> : null}
    </div>
  );
}

/**
 * Section-header property picker — the same All properties / house / Select all
 * menu as the top bar, in the slot that used to be a static "All properties" tag.
 */
export function SettingsPropertyScopeEcho() {
  return <SettingsPropertyScopePicker compact dataAttr="settings-property-scope-echo" />;
}
