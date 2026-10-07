import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ bucket: string; applicationId: string }>;
}) {
  const { bucket, applicationId } = await params;
  return renderProPortalSection("applications", [bucket, applicationId]);
}
