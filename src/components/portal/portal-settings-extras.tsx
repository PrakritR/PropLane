"use client";

import { Download, LogOut } from "lucide-react";
import { AccountProcessingFeeSettings } from "@/components/portal/account-processing-fee-settings";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { DARK_MODE_ENABLED } from "@/lib/theme-storage";
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
    <>
      <PortalSettingsSection title="Session">
        <PortalSettingsGroup>
          {variant === "full" && DARK_MODE_ENABLED ? <PortalSettingsRow label="Appearance"><ThemeToggle className="shrink-0" /></PortalSettingsRow> : null}
          <PortalRoleSwitcher currentKind={currentKind} asSettingsRow />
          {currentKind === "manager" || currentKind === "pro" ? (
            <div className="flex min-h-12 items-center gap-3 border-b border-border px-4">
              <Download aria-hidden className="h-[18px] w-[18px] text-muted" />
              <PortalDataExportButton className="flex min-h-12 flex-1 items-center text-left text-[15px] text-foreground" />
            </div>
          ) : null}
          <div className="flex min-h-12 items-center gap-3 px-4">
            <LogOut aria-hidden className="h-[18px] w-[18px] text-muted" />
            <PortalSignOutButton className="flex min-h-12 flex-1 items-center text-left text-[15px] text-foreground disabled:opacity-60" />
          </div>
        </PortalSettingsGroup>
      </PortalSettingsSection>
      {currentKind === "manager" || currentKind === "pro" ? <AccountProcessingFeeSettings /> : null}
      <PortalSettingsSection title="Danger zone">
        <PortalSettingsGroup>
          <PortalDeleteAccountButton portalKind={currentKind} className="flex min-h-12 w-full items-center px-4 text-left text-[15px] text-danger" />
        </PortalSettingsGroup>
      </PortalSettingsSection>
    </>
  );
}
