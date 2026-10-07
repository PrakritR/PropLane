import { OwnerOverview } from "@/components/owner/owner-overview";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Overview" };

export default async function OwnerOverviewPage() {
  await requireOwnerPage();
  return <OwnerOverview />;
}
