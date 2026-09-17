"use client";

import { ChevronRight, ExternalLink, Pencil } from "lucide-react";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { SaveStatus } from "@/components/ui/save-status";
import type { AutosaveState } from "@/hooks/use-autosave-draft";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  SettingsPanelModalSaveButton,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/pro-portal-settings-panels";
import { ManagerPropertyApplicationFormEditor } from "@/components/portal/pro-edit-application-modal";
import { ManagerPropertyLeaseFormEditor } from "@/components/portal/pro-edit-leases-modal";
import {
  SettingsModulePage,
  type SettingsModulePageHandle,
  type SettingsModuleSaveStatus,
} from "@/components/portal/settings-module-page";
import { getSettingsEntryPointForTab } from "@/components/portal/settings-entry-points";
import { MANAGER_PORTAL_SETTINGS_TABS, managerSettingsHubTab } from "@/lib/portal-settings-section";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import {
  FormAutomationPaneSwitch,
  type FormAutomationPane,
} from "@/components/portal/property-form-automation-chrome";
import { cn } from "@/lib/utils";
import {
  SettingsPropertyScopeBar,
  SettingsPropertyScopeProvider,
} from "@/components/portal/settings-property-scope";

type SettingsEditorPane = FormAutomationPane;

function isFormAutomationTab(tab: ManagerPortalSettingsTab): boolean {
  return tab === "applications" || tab === "lease";
}

export type ManagerPortalSettingsTab =
  | "properties"
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

/** Operations gears that share the hub's Property picker (All properties or one house). */
const OPERATIONS_SCOPE_TABS = new Set<ManagerPortalSettingsTab>(["inspections", "bookings", "tasks"]);

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
  onFormSaved,
  initialPane = "form",
}: {
  open: boolean;
  onClose: () => void;
  /**
   * The section's "Edit … configuration" entry. The redesign moved module Edit
   * out of the list toolbar and under Settings, so a section that still has a
   * per-property editor hands it in here; it renders as the first row and
   * closes this dialog before opening the editor.
   *
   * Applications and Lease no longer pass this — their form editors live on
   * the Form pane inside this sheet.
   */
  editAction?: { label: string; description?: string; onSelect: () => void; dataAttr?: string };
  /** Fired after the inline application / lease form writes a listing. */
  onFormSaved?: () => void;
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
  /**
   * Applications / Lease sheets start on Form so the catalog is one click away.
   * A property-page gear passes `"automation"` so handling, reminders, documents,
   * ending, and move-in are the first thing on screen — not only the form list.
   */
  initialPane?: SettingsEditorPane;
}) {
  const [tab, setTab] = useState<ManagerPortalSettingsTab>(initialTab);
  const [panelFooter, setPanelFooter] = useState<ManagerSettingsPanelFooter | null>(null);
  const [editorPane, setEditorPane] = useState<SettingsEditorPane>("form");
  const [formBulkActions, setFormBulkActions] = useState<ReactNode | null>(null);
  const [scopePropertyId, setScopePropertyId] = useState(initialPropertyId ?? "");
  const { userId: managerUserId } = useManagerUserId();
  const { showToast } = useAppUi();

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setEditorPane(isFormAutomationTab(initialTab) ? initialPane : "form");
      setFormBulkActions(null);
      setScopePropertyId(initialPropertyId ?? "");
    }
  }, [open, initialTab, initialPane, initialPropertyId]);

  const prevTabRef = useRef(initialTab);
  useEffect(() => {
    if (prevTabRef.current === tab) return;
    prevTabRef.current = tab;
    if (isFormAutomationTab(tab)) setEditorPane("form");
  }, [tab]);

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

  const selectEditorPane = useCallback(
    async (next: SettingsEditorPane) => {
      if (editorPane === next) return;
      const { ok } = await flushPendingSaves();
      if (!ok) return;
      setFormBulkActions(null);
      setPanelFooter(null);
      setEditorPane(next);
    },
    [editorPane, flushPendingSaves],
  );

  const handleFormBulkActions = useCallback((actions: ReactNode | null) => {
    setFormBulkActions(actions);
  }, []);

  const handleFormSaved = useCallback(() => {
    onFormSaved?.();
  }, [onFormSaved]);

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
    if (typeof window !== "undefined") {
      window.location.assign(`/portal/profile?tab=${managerSettingsHubTab(tab)}`);
    }
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
      panelClassName={cn(
        "p-3 sm:p-4",
        isFormAutomationTab(tab) && editorPane === "form" ? "max-w-4xl" : "max-w-lg",
      )}
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
        isFormAutomationTab(tab) && editorPane === "form"
          ? formBulkActions
            ? (
                <ModalFooter className="w-full justify-start">{formBulkActions}</ModalFooter>
              )
            : undefined
          : panelFooter
            ? (
                <ModalFooter>
                  <SettingsPanelModalSaveButton {...panelFooter} />
                </ModalFooter>
              )
            : undefined
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
              onClick={() => void selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {isFormAutomationTab(tab) ? (
        <FormAutomationPaneSwitch pane={editorPane} onChange={(next) => void selectEditorPane(next)} />
      ) : null}

      {isFormAutomationTab(tab) && editorPane === "form" ? (
        tab === "applications" ? (
          <ManagerPropertyApplicationFormEditor
            active={open}
            propertyOptions={propertyOptions}
            initialPropertyId={initialPropertyId}
            managerUserId={managerUserId}
            onSaved={handleFormSaved}
            showToast={showToast}
            onBulkActionsChange={handleFormBulkActions}
          />
        ) : (
          <ManagerPropertyLeaseFormEditor
            active={open}
            propertyOptions={propertyOptions}
            initialPropertyId={initialPropertyId}
            managerUserId={managerUserId}
            onSaved={handleFormSaved}
            showToast={showToast}
            onBulkActionsChange={handleFormBulkActions}
          />
        )
      ) : OPERATIONS_SCOPE_TABS.has(tab) ? (
        <SettingsPropertyScopeProvider
          propertyId={scopePropertyId}
          onPropertyIdChange={setScopePropertyId}
          options={propertyOptions}
        >
          <SettingsPropertyScopeBar />
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
        </SettingsPropertyScopeProvider>
      ) : (
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
      )}
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
