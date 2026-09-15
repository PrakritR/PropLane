"use client";

import { ThemeToggle } from "@/components/layout/theme-toggle";
import { PortalRoleSwitcher } from "@/components/portal/portal-role-switcher";
import { PortalDataExportButton } from "@/components/portal/portal-data-export-button";
import { PortalDeleteAccountButton } from "@/components/portal/portal-delete-account-button";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import type { PortalKind } from "@/lib/portal-types";

/**
 * Account actions on the Settings page. The default `full` variant keeps the
 * legacy composition (theme + portal switch + sign out + delete) used by the
 * resident, vendor, and admin settings pages. The manager settings layout
 * passes `session`, which drops the Appearance row (it lives in the manager's
 * Preferences category instead) and keeps only workspace/session actions.
 */
export function PortalSettingsExtras({
  currentKind,
  variant = "full",
}: {
  currentKind: PortalKind;
  variant?: "full" | "session";
}) {
  return (
    <PortalSettingsSection
      title="Account"
    >
      <PortalSettingsGroup>
        {variant === "full" ? (
          <PortalSettingsRow label="Appearance">
            <ThemeToggle className="shrink-0" />
          </PortalSettingsRow>
        ) : null}

        <PortalRoleSwitcher currentKind={currentKind} asSettingsRow />

        <div className="border-b border-border px-4 py-3.5 last:border-0">
          <PortalSignOutButton className="text-sm font-medium text-foreground underline-offset-2 transition hover:underline disabled:opacity-60" />
        </div>

        {currentKind === "manager" || currentKind === "pro" ? (
          <PortalSettingsRow
            label="Export my data"
          >
            <PortalDataExportButton className="text-sm font-medium text-foreground underline-offset-2 transition hover:underline" />
          </PortalSettingsRow>
        ) : null}

        <div className="px-4 py-3.5">
          <PortalDeleteAccountButton
            portalKind={currentKind}
            className="text-sm font-medium text-danger underline-offset-2 transition hover:underline"
          />
        </div>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
