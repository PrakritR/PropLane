import ResidentSetupClient from "./resident-setup-client";

export const dynamic = "force-dynamic";

export default function ResidentSetupPage() {
  return <ResidentSetupClient identityEnabled={process.env.RESIDENT_IDENTITY_ENABLED === "true"} />;
}
