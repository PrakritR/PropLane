import { renderResidentPortalSection } from "@/lib/render-portal-section/resident";

export default async function ResidentPaymentDetailPage({
  params,
}: {
  params: Promise<{ bucket: string; chargeId: string }>;
}) {
  const { bucket, chargeId } = await params;
  return renderResidentPortalSection("payments", [bucket, chargeId]);
}
