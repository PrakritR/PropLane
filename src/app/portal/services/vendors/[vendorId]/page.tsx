import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ vendorId: string }>;
}) {
  const { vendorId } = await params;
  return renderProPortalSection("services", ["vendors", vendorId]);
}
