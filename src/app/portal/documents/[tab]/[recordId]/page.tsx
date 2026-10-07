import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function DocumentsRecordPage({
  params,
}: {
  params: Promise<{ tab: string; recordId: string }>;
}) {
  const { tab, recordId } = await params;
  return renderProPortalSection("documents", [tab, recordId]);
}
