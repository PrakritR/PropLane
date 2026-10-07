import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function PromotionDetailPage({
  params,
}: {
  params: Promise<{ assetId: string }>;
}) {
  const { assetId } = await params;
  return renderProPortalSection("promotion", [decodeURIComponent(assetId)]);
}
