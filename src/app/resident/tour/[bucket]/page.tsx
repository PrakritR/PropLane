import { renderResidentPortalSection } from "@/lib/render-portal-section/resident";

export default async function ResidentTourListPage({
  params,
}: {
  params: Promise<{ bucket: string }>;
}) {
  const { bucket } = await params;
  return renderResidentPortalSection("tour", [bucket]);
}
