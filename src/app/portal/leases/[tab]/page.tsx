import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function LeasesListPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  return renderProPortalSection("leases", [tab]);
}
