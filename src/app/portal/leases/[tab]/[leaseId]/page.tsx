import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function LeaseDetailPage({
  params,
}: {
  params: Promise<{ tab: string; leaseId: string }>;
}) {
  const { tab, leaseId } = await params;
  return renderProPortalSection("leases", [tab, leaseId]);
}
