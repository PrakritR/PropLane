"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  allWorkspacePropertyOptions,
  unionLabeledPropertyOptions,
} from "@/lib/workspaces/selection";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import {
  PortalSettingsLinkRow,
  PortalSettingsSection,
  PortalSettingsSections,
} from "@/components/portal/portal-settings-ui";
import {
  SettingsModulePage,
  type SettingsModulePageHandle,
  type SettingsModuleSaveStatus,
} from "@/components/portal/settings-module-page";
import {
  SettingsPanelModalSaveButton,
  type ManagerSettingsPanelFooter,
} from "@/components/portal/pro-portal-settings-panels";
import { SaveStatus } from "@/components/ui/save-status";
import { MANAGER_PORTAL_SETTINGS_TABS } from "@/lib/portal-settings-section";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";
import { SettingsPropertyScopeProvider } from "@/components/portal/settings-property-scope";
import { SettingsScopeBar } from "@/components/portal/settings-scope-bar";

/**
 * `/portal/settings/<tab>` — the standalone page every per-section gear's "Open in Settings ↗"
 * link points at. Reuses `PortalProfileClient`'s responsive list→detail shape: a rail beside the
 * content at desktop width, a list that pushes to a detail pane on phones.
 *
 * Unlike `PortalProfileClient` (which drives its pane through a `?tab=` query param and
 * `history.pushState`, because every pane there lives behind ONE server-rendered route), the
 * active module here already IS a real, linkable, reloadable URL segment
 * (`/portal/settings/<tab>` — see `render-portal-section.tsx`'s `settings` branch), so switching
 * modules is a normal navigation rather than a client-only history hack. The one thing that IS
 * local-only state is which of (list, detail) a phone shows: there is no dedicated top-level
 * "Settings" nav entry, and bare `/portal/settings` always resolves to a default module server-side
 * (see `DEFAULT_MANAGER_SETTINGS_TAB`), so there is no bare "list root" URL to send a phone's back
 * gesture to. The list is a same-page overlay instead — closing it never re-fetches anything.
 */
export function PortalSettingsSectionClient({
  tab,
  basePath,
}: {
  /** `null` when the URL named an area this registry does not recognize — see the fallback below. */
  tab: ManagerPortalSettingsTab | null;
  basePath: string;
}) {
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [footer, setFooter] = useState<ManagerSettingsPanelFooter | null>(null);
  const [saveStatus, setSaveStatus] = useState<SettingsModuleSaveStatus>({
    state: "idle",
    reason: null,
    savedAt: null,
  });
  const pageRef = useRef<SettingsModulePageHandle>(null);
  const [scopePropertyIds, setScopePropertyIds] = useState<string[]>([]);
  const [scopeWorkspaceId, setScopeWorkspaceId] = useState("");
  const scopePropertyId = scopePropertyIds[0] ?? "";

  /**
   * The full account list — `SettingsScopeBar` narrows it to whichever
   * workspace is chosen (PLAN-0920-0845 phase D), so this must NOT
   * pre-filter to only the currently active one the way it used to; a
   * workspace the manager picks in the bar that is not the active one still
   * needs its own houses to choose from.
   *
   * This is the identical call `pro-applications.tsx` makes. It reads locally
   * cached portfolio state synchronously rather than fetching, so it costs
   * nothing here and needs no loading state.
   */
  const { userId } = useManagerUserId();
  const workspaces = useWorkspaces();
  const propertyOptions = useMemo(
    () =>
      unionLabeledPropertyOptions(
        allWorkspacePropertyOptions(workspaces?.workspaces ?? []),
        buildManagerPropertyFilterOptions(resolveManagerScopeUserId(userId)),
      ),
    [userId, workspaces?.workspaces],
  );

  useEffect(() => {
    setFooter(null);
    setSaveStatus({ state: "idle", reason: null, savedAt: null });
  }, [tab]);

  /**
   * The mobile list↔detail split above is local `useState`, unlike
   * `portal-profile-client.tsx`'s `?tab=` query param — this route's URL already names the
   * module (`/portal/settings/<tab>`, per this file's own doc comment), and the list has no URL
   * of its own. Without a pushed history entry, the detail view is the page's ONLY entry, so
   * browser/native Back skips past the list and leaves Settings entirely — a broken gesture on
   * the native shells that load this same site. Push one entry per module so Back has somewhere
   * local to land, mirroring `portal-profile-client.tsx`'s own `openGroup`/`backToRoot`
   * pushState/popstate pattern, inverted: there the list is the default and opening a module
   * pushes; here the detail IS the default (the URL already names it), so entering the list is
   * what popping that pushed entry represents.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !tab) return;
    if ((window.history.state as { settingsDetailTab?: string } | null)?.settingsDetailTab !== tab) {
      window.history.pushState({ settingsDetailTab: tab }, "", window.location.href);
    }
  }, [tab]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as { settingsDetailTab?: string } | null;
      setMobileListOpen(state?.settingsDetailTab !== tab);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [tab]);

  /**
   * Tapping the in-app "Settings" back control: when the pushed detail entry above is still the
   * live one, hand off to a REAL `history.back()` so the in-app control and the native back
   * gesture do the exact same thing — including on a double-tap, which must land once on the
   * list and never pop past it. Once Back has already been pressed once (list already showing,
   * no pushed entry left to pop), just show the list locally.
   */
  function openMobileList() {
    if (
      typeof window !== "undefined" &&
      (window.history.state as { settingsDetailTab?: string } | null)?.settingsDetailTab === tab
    ) {
      window.history.back();
      return;
    }
    setMobileListOpen(true);
  }

  /** Selecting the CURRENT tab from the list closes it back to the detail view — re-push the
   *  detail layer so Back is available again to return to the list. */
  function closeMobileListToDetail() {
    if (
      typeof window !== "undefined" &&
      (window.history.state as { settingsDetailTab?: string } | null)?.settingsDetailTab !== tab
    ) {
      window.history.pushState({ settingsDetailTab: tab }, "", window.location.href);
    }
    setMobileListOpen(false);
  }

  const activeMeta = tab ? (MANAGER_PORTAL_SETTINGS_TABS.find((item) => item.id === tab) ?? null) : null;

  /**
   * Flush the module currently on screen before leaving it — mirrors `ProPortalSettingsModal`'s
   * own `selectTab`/`closeAndSave` ordering. A plain navigation (not client-side routing) for the
   * same untouched-test reason `pro-portal-settings-modal.tsx` documents on its own link.
   */
  async function goToArea(nextTab: ManagerPortalSettingsTab) {
    if (nextTab === tab) {
      closeMobileListToDetail();
      return;
    }
    const { ok } = (await pageRef.current?.flushPendingSaves()) ?? { ok: true };
    if (!ok) return;
    if (typeof window !== "undefined") {
      window.location.assign(`${basePath}/settings/${nextTab}`);
    }
  }

  const showList = mobileListOpen || !tab;

  return (
    // The left rail below already names every module ("Applications", "Tours",
    // …) and the active one repeats its own name as a `PortalSettingsSection`
    // title — a generic "Settings" header row above both was always a third,
    // redundant label. Same header-less shell as `PortalProfileClient`'s Settings
    // pane; keep a semantic h1 (sr-only) for a11y/SEO without the visual duplicate.
    <ManagerPortalPageShell title="Settings" navigationProvidesTitle hideTitleOnMobileNav>
      <div className="lg:flex lg:items-start lg:gap-10">
        <nav
          aria-label="Settings sections"
          className="sticky top-0 w-60 shrink-0 space-y-0.5 rounded-2xl border border-border bg-card/60 p-2.5 max-lg:hidden"
        >
          {MANAGER_PORTAL_SETTINGS_TABS.map((item) => {
            const active = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void goToArea(item.id)}
                aria-current={active ? "page" : undefined}
                data-attr={`settings-nav-${item.id}`}
                className={
                  active
                    ? "flex min-h-10 w-full items-center rounded-xl bg-primary/10 px-2.5 py-2 text-left text-[13px] font-medium tracking-[-0.01em] text-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_18%,transparent)]"
                    : "flex min-h-10 w-full items-center rounded-xl px-2.5 py-2 text-left text-[13px] font-medium tracking-[-0.01em] text-muted transition-colors duration-150 hover:bg-[var(--secondary)]/70 hover:text-foreground"
                }
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 lg:max-w-3xl">
          {showList ? (
            <div className="space-y-2 lg:hidden">
              <div className="overflow-hidden rounded-2xl border border-border bg-card">
                {MANAGER_PORTAL_SETTINGS_TABS.map((item) => (
                  <PortalSettingsLinkRow
                    key={item.id}
                    label={item.label}
                    onClick={() => void goToArea(item.id)}
                    dataAttr={`settings-open-${item.id}`}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="mb-4 lg:hidden">
              <PortalDetailHeader
                title={activeMeta?.label ?? "Settings"}
                onBack={openMobileList}
                backLabel="Settings"
                bare
                dataAttrBack="settings-back-to-root"
              />
            </div>
          )}

          <PortalSettingsSections className={showList ? "max-lg:hidden" : undefined}>
            {tab ? (
              <SettingsPropertyScopeProvider
                workspaceId={scopeWorkspaceId}
                onWorkspaceIdChange={setScopeWorkspaceId}
                propertyIds={scopePropertyIds}
                onPropertyIdsChange={setScopePropertyIds}
                options={propertyOptions}
              >
                <PortalSettingsSection
                  title={activeMeta?.label ?? "Settings"}
                  action={
                    <div className="flex items-center gap-2">
                      <SettingsScopeBar />
                      <SaveStatus
                        status={{
                          state: saveStatus.state,
                          reason: saveStatus.reason,
                          savedAt: saveStatus.savedAt,
                          retry: () => {
                            void pageRef.current?.flushPendingSaves();
                          },
                          flush: async () => {
                            await pageRef.current?.flushPendingSaves();
                          },
                          dirty: saveStatus.state === "saving",
                        }}
                      />
                    </div>
                  }
                >
                  <SettingsModulePage
                    ref={pageRef}
                    tab={tab}
                    propertyOptions={propertyOptions}
                    initialPropertyId={scopePropertyId}
                    onFooterChange={setFooter}
                    onSaveStatusChange={setSaveStatus}
                    showFormLink
                  />
                  {footer ? (
                    <div className="flex justify-end">
                      <SettingsPanelModalSaveButton {...footer} />
                    </div>
                  ) : null}
                </PortalSettingsSection>
              </SettingsPropertyScopeProvider>
            ) : (
              <PortalSettingsSection
                title="Settings module not found"
              >
                <p className="px-1 text-sm text-muted">
                  Nothing here yet — choose a module from {MANAGER_PORTAL_SETTINGS_TABS[0]?.label} onward.
                </p>
              </PortalSettingsSection>
            )}
          </PortalSettingsSections>
        </div>
      </div>
    </ManagerPortalPageShell>
  );
}
