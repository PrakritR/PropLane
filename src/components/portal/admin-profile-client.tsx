import { PortalProfileClient } from "@/components/portal/portal-profile-client";

export function AdminProfileClient({
  fullName,
  email,
  phone,
  phoneVerified,
  adminId,
}: {
  fullName: string;
  email: string;
  phone: string;
  phoneVerified?: boolean;
  adminId: string;
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
    />
  );
}
