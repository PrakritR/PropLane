import { renderPortalSection, type PortalSearchParams } from "@/lib/render-portal-section/resident";

export default async function ResidentSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string; tab?: string[] }>;
  searchParams: Promise<PortalSearchParams>;
}) {
  const { section, tab } = await params;
  return renderPortalSection("resident", section, tab, await searchParams);
}
