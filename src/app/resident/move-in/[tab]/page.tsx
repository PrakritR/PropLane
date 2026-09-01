import { renderPortalSection, type PortalSearchParams } from "@/lib/render-portal-section";

/** Routed House details sub-tabs (placement, housemates, info, amenities, move-in). */
export default async function ResidentMoveInTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab: string }>;
  searchParams: Promise<PortalSearchParams>;
}) {
  const { tab } = await params;
  return renderPortalSection("resident", "move-in", [tab], await searchParams);
}
