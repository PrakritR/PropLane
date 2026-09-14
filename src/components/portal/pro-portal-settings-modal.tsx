"use client";

import { ChevronRight, ExternalLink, Pencil } from "lucide-react";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { SaveStatus } from "@/components/ui/save-status";
import type { AutosaveState } from "@/hooks/use-autosave-draft";
import {
  SettingsPanelModalSaveButton,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/pro-portal-settings-panels";
import {
  SettingsModulePage,
  type SettingsModulePageHandle,
  type SettingsModuleSaveStatus,
} from "@/components/portal/settings-module-page";
import { getSettingsEntryPointForTab } from "@/components/portal/settings-entry-points";
import { MANAGER_PORTAL_SETTINGS_TABS } from "@/lib/portal-settings-section";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";

export type ManagerPortalSettingsTab =
  | "applications"
  | "tours"
  | "lease"
  | "tasks"
  | "resident"
  | "payments"
  | "services"
  | "communication"
  | "bookings"
  | "inspections"
  | "automation";

export function ProPortalSettingsModal({
  open,
  onClose,
  initialTab = "applications",
  scoped = true,
  scopedTitle,
  onCalendarSettingsSaved,
  propertyOptions = [],
  initialPropertyId,
  paymentsMode = "incoming",
  editAction,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * The section's "Edit … configuration" entry. The redesign moved module Edit
   * out of the list toolbar and under Settings, so a section that still has a
   * per-property editor hands it in here; it renders as the first row and
   * closes this dialog before opening the editor.
   */
  editAction?: { label: string; description?: string; onSelect: () => void; dataAttr?: string };
  initialTab?: ManagerPortalSettingsTab;
  /** Incoming payments = resident rent reminders; outgoing = manager payee reminders. */
  paymentsMode?: "incoming" | "outgoing";
  /**
   * Show ONLY `initialTab`'s settings, titled for that section.
   *
   * Settings opened from a section's own header should be that section's settings. Offering all
   * six tabs there makes the manager re-find the one they were already standing in, and invites
   * them to change Payments from inside Applications. Pass `scoped={false}` only for a deliberate
   * global settings hub.
   */
  scoped?: boolean;
  /** When scoped, overrides the default "{Tab label} settings" title (e.g. Tours → tour notice). */
  scopedTitle?: string;
  /** Called after Calendar settings save so the availability grid can pick up new defaults. */
  onCalendarSettingsSaved?: () => void;
  /** Live manager properties for Applications / Lease automation settings. */
  propertyOptions?: { id: string; label: string }[];
  /** Pre-select a property when opening from a filtered section. */
  initialPropertyId?: string;
}) {
  const [tab, setTab] = useState<ManagerPortalSettingsTab>(initialTab);
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  /** Idle/saving/saved/failed for the `SaveStatus` mark beside the modal title. */
  const [saveStatus, setSaveStatus] = useState<{
    state: AutosaveState;
    reason: string | null;
    savedAt: number | null;
  }>({ state: "idle", reason: null, savedAt: null });
  const handleSaveStatusChange = useCallback((status: SettingsModuleSaveStatus) => setSaveStatus(status), []);
  // Radix's Dialog.Close fires both its own dismiss (onOpenChange) AND the
  // header button's explicit onClick, so `closeAndSave` can be entered twice
  // for one user click. The module page's own flush already collapses
  // concurrent flush calls into one run; this collapses them into one
  // `onClose()` too.
  const closeCalledRef = useRef(false);
  useEffect(() => {
    if (open) {
      setSaveStatus({ state: "idle", reason: null, savedAt: null });
      closeCalledRef.current = false;
    }
  }, [open]);

  /**
   * Every autosaving panel is now owned by `SettingsModulePage`, mounted only while ITS tab is
   * selected — a tab switch (or dialog close) unmounts it. This ref is the seam: both
   * `closeAndSave` and `selectTab` flush through it and await the result before acting, exactly
   * the ordering fix this file has carried since (see `tests/unit/portal-settings-save-flush.test.tsx`).
   */
  const pageRef = useRef<SettingsModulePageHandle>(null);
  const flushPendingSaves = useCallback(async (): Promise<{ ok: boolean }> => {
    return (await pageRef.current?.flushPendingSaves()) ?? { ok: true };
  }, []);

  // Not inside the setTab updater: React may invoke an updater twice, which
  // would fire every save a second time. Flush and AWAIT before switching —
  // switching to a new module while a save is still in flight would unmount
  // the outgoing panel and drop its edit exactly like the close bug this
  // guards against.
  const selectTab = useCallback(
    async (next: ManagerPortalSettingsTab) => {
      if (tab === next) return;
      const { ok } = await flushPendingSaves();
      if (!ok) return; // keep the manager on the tab that failed to save
      setTab(next);
    },
    [tab, flushPendingSaves],
  );

  /**
   * `onClose` used to run BEFORE the flush, so a panel that unmounts
   * synchronously on close had already nulled its ref by the time the save
   * fired — the edit vanished, and because every save was `void`-ed, a
   * rejected save looked exactly like a successful one. Flush and await FIRST;
   * only close once every panel's save has actually landed.
   */
  const closeAndSave = useCallback(async () => {
    const { ok } = await flushPendingSaves();
    if (!ok) return; // stay open — the failure is already surfaced via toast + header status
    if (closeCalledRef.current) return;
    closeCalledRef.current = true;
    onClose();
  }, [flushPendingSaves, onClose]);

  const tabEntry = getSettingsEntryPointForTab(tab);

  /**
   * Same flush-and-await ordering as `closeAndSave`, then a real navigation to the module's own
   * page. A plain `window.location` assignment rather than the Next router — this component is
   * exercised directly (no app-router context) by `tests/unit/portal-settings-save-flush.test.tsx`,
   * which this file must not require editing, so it takes no dependency on `next/navigation`.
   */
  const openInSettings = useCallback(async () => {
    const { ok } = await flushPendingSaves();
    if (!ok) return;
    closeCalledRef.current = true;
    onClose();
    if (typeof window !== "undefined") window.location.assign(`/portal/settings/${tab}`);
  }, [flushPendingSaves, onClose, tab]);

  return (
    <Modal
      open={open}
      onClose={closeAndSave}
      title={
        scoped
          ? `${scopedTitle ?? MANAGER_PORTAL_SETTINGS_TABS.find((item) => item.id === tab)?.label ?? "Settings"} settings`
          : "Settings"
      }
      dense
      assistantContext={
        scoped
          ? `${scopedTitle ?? MANAGER_PORTAL_SETTINGS_TABS.find((item) => item.id === tab)?.label ?? "Settings"} settings`
          : "Portal settings"
      }
      panelClassName="max-w-lg p-3 sm:p-4"
      status={
        <SaveStatus
          status={{
            state: saveStatus.state,
            reason: saveStatus.reason,
            savedAt: saveStatus.savedAt,
            retry: () => {
              void flushPendingSaves();
            },
            flush: async () => {
              await flushPendingSaves();
            },
            dirty: saveStatus.state === "saving",
          }}
        />
      }
      // A save in flight must not be raced by an outside click or Escape closing
      // the dialog out from under it — the flush already keeps the panel's edit
      // safe, but blocking dismissal here keeps the "saving…" mark truthful.
      dismissBlocked={saveStatus.state === "saving"}
      footer={
        panelFooter ? (
          <ModalFooter>
            <SettingsPanelModalSaveButton {...panelFooter} />
          </ModalFooter>
        ) : undefined
      }
    >
      {editAction ? (
        <button
          type="button"
          className="mb-3 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          data-attr={editAction.dataAttr ?? "manager-settings-edit-configuration"}
          onClick={() => {
            // Same ordering fix as closeAndSave: flush and await before this
            // dialog closes, so opening the per-property editor can never
            // step on a still-pending save from the tab just left.
            void (async () => {
              const { ok } = await flushPendingSaves();
              if (!ok) return;
              onClose();
              editAction.onSelect();
            })();
          }}
        >
          <Pencil className="size-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">{editAction.label}</span>
            {editAction.description ? (
              <span className="block text-xs text-muted">{editAction.description}</span>
            ) : null}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
      ) : null}

      {/* Every gear opens the same module page a manager can also reach as its own URL — this is
          that door, so a link shared in chat or bookmarked lands somewhere real. */}
      <button
        type="button"
        className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        data-attr={`${tabEntry.dataAttr}-open-in-settings`}
        onClick={() => void openInSettings()}
      >
        Open in Settings
        <ExternalLink className="size-3.5" aria-hidden />
      </button>

      {/* A scoped dialog is already ON its one section, so a switcher would only offer the manager
          a way to wander out of it. */}
      {scoped ? null : (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {MANAGER_PORTAL_SETTINGS_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : PORTAL_TOOLBAR_PILL_BUTTON}
              data-attr={`manager-settings-tab-${item.id}`}
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      <SettingsModulePage
        ref={pageRef}
        tab={tab}
        propertyOptions={propertyOptions}
        initialPropertyId={initialPropertyId}
        paymentsMode={paymentsMode}
        onCalendarSettingsSaved={onCalendarSettingsSaved}
        onFooterChange={setPanelFooter}
        onSaveStatusChange={handleSaveStatusChange}
        active={open}
      />
    </Modal>
  );
}

/** @deprecated Use ProPortalSettingsModal — kept for manager-* import sites. */
export const ManagerPortalSettingsModal = ProPortalSettingsModal;

/** @deprecated Use ProPortalSettingsModal — kept for imports that open application settings only. */
export function ManagerApplicationSettingsModal({
  open,
  onClose,
  propertyOptions = [],
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions?: { id: string; label: string }[];
}) {
  return (
    <ProPortalSettingsModal
      open={open}
      onClose={onClose}
      initialTab="applications"
      scoped
      propertyOptions={propertyOptions}
    />
  );
}
