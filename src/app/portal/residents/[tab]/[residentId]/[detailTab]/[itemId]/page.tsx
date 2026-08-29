import { renderProPortalSection } from "@/lib/portal-section-page";

export default async function ResidentDetailItemPage({
  params,
}: {
  params: Promise<{ tab: string; residentId: string; detailTab: string; itemId: string }>;
}) {
  const { tab, residentId, detailTab, itemId } = await params;
  return renderProPortalSection("residents", [tab, residentId, detailTab, itemId]);
}
