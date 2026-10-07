import { renderResidentPortalSection } from "@/lib/render-portal-section/resident";

export default async function ResidentApplicationDetailPage({
  params,
}: {
  params: Promise<{ bucket: string; applicationId: string }>;
}) {
  const { bucket, applicationId } = await params;
  return renderResidentPortalSection("applications", [bucket, applicationId]);
}
