import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function PropertyDetailTabPage({
  params,
}: {
  params: Promise<{ stage: string; propertyKey: string; detailTab: string }>;
}) {
  const { stage, propertyKey, detailTab } = await params;
  return renderProPortalSection("properties", [stage, propertyKey, detailTab]);
}
