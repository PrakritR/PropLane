import { OwnerProfile } from "@/components/owner/owner-profile";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Profile" };

export default async function OwnerProfileRoute() {
  const who = await requireOwnerPage();
  return <OwnerProfile name={who.name} email={who.email} />;
}
