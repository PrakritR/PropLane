"use client";

/**
 * Settings → Workspace → Balance & payouts → "Rent & fees": payment setup, the
 * processing fee and late fees. The Payments list's gear links here
 * (`MANAGER_SETTINGS_GEAR_TARGETS.payments`). Each control keeps the storage it
 * always had: the manual-payment settings route for setup, fee payer and
 * autopay, and the per-listing late-fee route for late fees.
 */
import { PaymentListingLateFeeSettings } from "@/components/portal/payment-late-fee-settings";
import { ManagerPaymentSetupPanel } from "@/components/portal/pro-payment-setup-modal";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { SettingsPropertyScope, useWorkspacePropertyOptions } from "@/components/portal/settings-property-scope-picker";
import { useWorkspaces } from "@/components/portal/workspace-provider";

export function RentAndFeesSettingsSection() {
  const workspaces = useWorkspaces();
  const { workspaceId, options } = useWorkspacePropertyOptions();
  return (
    <PortalSettingsSection id="rent-and-fees" title="Rent & fees">
      <ManagerPaymentSetupPanel active section="setup" propertyOptions={options} />
      <ManagerPaymentSetupPanel active section="fee" propertyOptions={options} />
      <SettingsPropertyScope>
        <PortalSettingsGroup>
          <PaymentListingLateFeeSettings
            propertyOptions={options}
            workspaceId={workspaceId || undefined}
            workspaceName={workspaces?.active?.name}
          />
        </PortalSettingsGroup>
      </SettingsPropertyScope>
    </PortalSettingsSection>
  );
}
