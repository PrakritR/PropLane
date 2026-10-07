import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function PropertyDetailSubpagePage({
  params,
}: {
  params: Promise<{ stage: string; propertyKey: string; detailTab: string; subpage: string }>;
}) {
  const { stage, propertyKey, detailTab, subpage } = await params;
  return renderProPortalSection("properties", [stage, propertyKey, detailTab, subpage]);
}
