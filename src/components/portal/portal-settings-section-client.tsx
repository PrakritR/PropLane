"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { resolveManagerScopeUserId } from "@/lib/demo/demo-session";
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

  /**
   * The Applications and Lease modules are per-property, so without these the
   * standalone page renders an "Applies to" row with nothing in it and tells a
   * manager who already owns properties to go and add one — the same host
   * reached through a section's gear had the real list all along.
   *
   * This is the identical call `pro-applications.tsx` makes. It reads locally
   * cached portfolio state synchronously rather than fetching, so it costs
   * nothing here and needs no loading state. Every other module ignores it.
   */
  const { userId } = useManagerUserId();
  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(resolveManagerScopeUserId(userId)),
    [userId],
  );

  useEffect(() => {
    setFooter(null);
    setSaveStatus({ state: "idle", reason: null, savedAt: null });
  }, [tab]);

  const activeMeta = tab ? (MANAGER_PORTAL_SETTINGS_TABS.find((item) => item.id === tab) ?? null) : null;

  /**
   * Flush the module currently on screen before leaving it — mirrors `ProPortalSettingsModal`'s
   * own `selectTab`/`closeAndSave` ordering. A plain navigation (not client-side routing) for the
   * same untouched-test reason `pro-portal-settings-modal.tsx` documents on its own link.
   */
  async function goToArea(nextTab: ManagerPortalSettingsTab) {
    if (nextTab === tab) {
      setMobileListOpen(false);
      return;
    }
    const { ok } = (await pageRef.current?.flushPendingSaves()) ?? { ok: true };
    if (!ok) return;
    if (typeof window !== "undefined") window.location.assign(`${basePath}/settings/${nextTab}`);
  }

  const showList = mobileListOpen || !tab;

  return (
    <ManagerPortalPageShell title="Settings" hideTitleOnMobileNav>
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
                onBack={() => setMobileListOpen(true)}
                backLabel="Settings"
                bare
                dataAttrBack="settings-back-to-root"
              />
            </div>
          )}

          <PortalSettingsSections className={showList ? "max-lg:hidden" : undefined}>
            {tab ? (
              <PortalSettingsSection
                title={activeMeta?.label ?? "Settings"}
                action={
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
                }
              >
                <SettingsModulePage
                  ref={pageRef}
                  tab={tab}
                  propertyOptions={propertyOptions}
                  onFooterChange={setFooter}
                  onSaveStatusChange={setSaveStatus}
                />
                {footer ? (
                  <div className="flex justify-end">
                    <SettingsPanelModalSaveButton {...footer} />
                  </div>
                ) : null}
              </PortalSettingsSection>
            ) : (
              <PortalSettingsSection
                title="Settings module not found"
                description="That settings section doesn't exist. Pick one from the list."
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
