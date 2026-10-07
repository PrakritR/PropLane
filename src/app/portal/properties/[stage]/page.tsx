import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function PropertiesListPage({
  params,
}: {
  params: Promise<{ stage: string }>;
}) {
  const { stage } = await params;
  return renderProPortalSection("properties", [stage]);
}
