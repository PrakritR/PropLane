import { OwnerProperty } from "@/components/owner/owner-property";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Property" };

export default async function OwnerPropertyPage({ params }: { params: Promise<{ propertyId: string }> }) {
  await requireOwnerPage();
  const { propertyId } = await params;
  return <OwnerProperty propertyId={decodeURIComponent(propertyId)} />;
}
