"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * How a per-control autosave inside a settings module reports itself to the
 * host's `SaveStatus` mark — Tours' notice stepper and auto-confirm toggle,
 * Task's lifecycle fields, Communication's AI-draft switch, every
 * `ManagerReminderRuleSettingsPanel` audience row (directly and through the
 * reminder bundles that wrap it), and the Applications/Lease automation
 * toggles handled directly in `settings-module-page.tsx`.
 *
 * This is deliberately NOT a second status mechanism: `SettingsModulePage` is
 * the one place that turns these events into `SettingsModuleSaveStatus` and
 * hands them to the SAME `onSaveStatusChange` prop `flushPendingSaves` has
 * always written to — a context instead of a threaded prop only because
 * several of these panels sit behind reminder-bundle wrapper components this
 * task does not own, and a context reaches through them without changing
 * their signatures.
 */
export type SettingsSaveStatusEvent =
  | { type: "start" }
  | { type: "success" }
  | { type: "failure"; reason: string };

export type ReportSettingsSaveStatus = (event: SettingsSaveStatusEvent) => void;

export const SettingsSaveStatusContext = createContext<ReportSettingsSaveStatus | null>(null);

/**
 * Read by every panel with its own per-control autosave. Outside a
 * `SettingsModulePage` (a panel's own standalone test, say, or
 * `settings-module-redraws.test.tsx` rendering it directly) this is a safe
 * no-op — reporting to a host that isn't there is not an error.
 */
export function useReportSettingsSaveStatus(): ReportSettingsSaveStatus {
  const ctx = useContext(SettingsSaveStatusContext);
  return ctx ?? NOOP_REPORT;
}

const NOOP_REPORT: ReportSettingsSaveStatus = () => {};

/**
 * A debounced per-control autosave (Tours, Tasks, Communication, every
 * `ManagerReminderRuleSettingsPanel`) is lost if its panel unmounts before the debounce timer
 * fires — a switched tab that the host DIDN'T explicitly flush first, or leaving Settings
 * entirely through a nav link this task does not own. `SettingsModulePage.flushPendingSaves()`
 * cannot fix this from a level above: React tears down a subtree bottom-up, so by the time any
 * ANCESTOR's own unmount cleanup runs, this panel has already deregistered its handle from the
 * save registry (`useSaveRegistryEntry`'s own cleanup already ran) and there is nothing left to
 * flush. Each panel has to flush ITSELF, from its own unmount, while its draft state is still
 * live.
 *
 * Reads `save`/`isDirty` through a ref so the cleanup closure (captured once, on mount) never
 * goes stale, and calls `save` only when something was actually pending — an unmount with nothing
 * dirty must stay a no-op.
 */
export function useFlushSettingsAutosaveOnUnmount(
  save: (options?: { silent?: boolean }) => Promise<boolean>,
  isDirty: boolean,
): void {
  const latestRef = useRef({ save, isDirty });
  useEffect(() => {
    latestRef.current = { save, isDirty };
  });
  useEffect(() => {
    return () => {
      if (latestRef.current.isDirty) {
        void latestRef.current.save({ silent: true });
      }
    };
  }, []);
}
