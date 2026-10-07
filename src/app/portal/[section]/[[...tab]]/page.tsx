import { renderPortalSection } from "@/lib/render-portal-section/manager";

export default async function PropertyPortalSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string; tab?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section, tab } = await params;
  return renderPortalSection("pro", section, tab, searchParams ? await searchParams : undefined);
}
