import { PortalProfileClient } from "@/components/portal/portal-profile-client";
import type { SettingsScope } from "@/lib/admin-team/settings-scope";

export function AdminProfileClient({
  fullName,
  email,
  phone,
  phoneVerified,
  adminId,
  settingsScope = null,
}: {
  fullName: string;
  email: string;
  phone: string;
  phoneVerified?: boolean;
  adminId: string;
  settingsScope?: SettingsScope | null;
}) {
  return (
    <PortalProfileClient
      variant="admin"
      portalKind="admin"
      initialFullName={fullName}
      initialEmail={email}
      initialPhone={phone}
      initialPhoneVerified={phoneVerified}
      idLabel="PropLane ID"
      idValue={adminId}
      settingsScope={settingsScope}
    />
  );
}
