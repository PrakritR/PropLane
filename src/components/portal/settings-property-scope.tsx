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

/**
 * Per-property scope for Operations settings (PLAN-0918-1500).
 *
 * One picker lives in the module title row. "" is the workspace default
 * ("All properties"). Panels read the scope through
 * {@link useSettingsPropertyScope} and add `?propertyId=` to their fetches.
 * Section headers are titles only — they do not repeat this control.
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
  const canReset =
    scope.propertyId !== "" && scope.overriddenPropertyIds.includes(scope.propertyId);
  const selectAllFooter = (close: () => void) => (
    <div className="flex flex-col">
      {canReset ? (
        <button
          type="button"
          data-attr="settings-property-scope-reset"
          className="w-full rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold text-primary hover:bg-accent/60"
          disabled={scope.loading}
          onClick={() => {
            scope.requestReset();
            close();
          }}
        >
          Reset to workspace default
        </button>
      ) : null}
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
    </div>
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
 * The one Settings property control — a compact pill for the module title row.
 * Hidden when the workspace has no houses. "" is All properties.
 */
export function SettingsPropertyScopeBar() {
  const scope = useSettingsPropertyScope();
  if (scope.options.length === 0) return null;
  return <SettingsPropertyScopePicker compact dataAttr="settings-property-scope" />;
}

/** Module title on the left, the one property picker on the right. */
export function SettingsPropertyScopeTitleRow({ title }: { title: string }) {
  return (
    <div className="mb-5 flex items-center justify-between gap-3 border-b border-border pb-3">
      <h2 className="hidden text-xl font-semibold tracking-[-0.02em] text-foreground lg:block">{title}</h2>
      <SettingsPropertyScopeBar />
    </div>
  );
}
