import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ServiceRequestDetailPage({
  params,
}: {
  params: Promise<{ bucket: string; requestId: string }>;
}) {
  const { bucket, requestId } = await params;
  return renderProPortalSection("services", ["requests", bucket, requestId]);
}
