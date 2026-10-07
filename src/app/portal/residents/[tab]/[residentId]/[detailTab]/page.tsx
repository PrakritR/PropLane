import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ResidentDetailTabPage({
  params,
}: {
  params: Promise<{ tab: string; residentId: string; detailTab: string }>;
}) {
  const { tab, residentId, detailTab } = await params;
  return renderProPortalSection("residents", [tab, residentId, detailTab]);
}
