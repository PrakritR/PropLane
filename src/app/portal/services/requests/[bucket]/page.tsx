import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ServiceRequestsListPage({
  params,
}: {
  params: Promise<{ bucket: string }>;
}) {
  const { bucket } = await params;
  return renderProPortalSection("services", ["requests", bucket]);
}
