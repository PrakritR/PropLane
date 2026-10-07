import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ResidentsListPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  return renderProPortalSection("residents", [tab]);
}
