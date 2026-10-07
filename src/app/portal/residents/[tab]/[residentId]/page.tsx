import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ResidentDetailPage({
  params,
}: {
  params: Promise<{ tab: string; residentId: string }>;
}) {
  const { tab, residentId } = await params;
  return renderProPortalSection("residents", [tab, residentId]);
}
