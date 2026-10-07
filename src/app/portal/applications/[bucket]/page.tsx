import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ApplicationsListPage({
  params,
}: {
  params: Promise<{ bucket: string }>;
}) {
  const { bucket } = await params;
  return renderProPortalSection("applications", [bucket]);
}
