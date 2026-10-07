import { renderResidentPortalSection } from "@/lib/render-portal-section/resident";

export default async function ResidentApplicationsListPage({
  params,
}: {
  params: Promise<{ bucket: string }>;
}) {
  const { bucket } = await params;
  return renderResidentPortalSection("applications", [bucket]);
}
