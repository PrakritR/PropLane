import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ direction: string; bucket: string; paymentId: string }>;
}) {
  const { direction, bucket, paymentId } = await params;
  return renderProPortalSection("payments", [direction, bucket, paymentId]);
}
