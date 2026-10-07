import { renderResidentPortalSection } from "@/lib/render-portal-section/resident";

export default async function ResidentTourDetailPage({
  params,
}: {
  params: Promise<{ bucket: string; inquiryId: string }>;
}) {
  const { bucket, inquiryId } = await params;
  return renderResidentPortalSection("tour", [bucket, inquiryId]);
}
