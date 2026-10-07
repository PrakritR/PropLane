import { renderResidentPortalSection } from "@/lib/render-portal-section/resident";

export default async function ResidentPaymentsListPage({
  params,
}: {
  params: Promise<{ bucket: string }>;
}) {
  const { bucket } = await params;
  return renderResidentPortalSection("payments", [bucket]);
}
