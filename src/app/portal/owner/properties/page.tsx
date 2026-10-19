import { OwnerPropertiesList } from "@/components/owner/owner-properties";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Properties" };

export default async function OwnerPropertiesPage() {
  await requireOwnerPage();
  return <OwnerPropertiesList />;
}
