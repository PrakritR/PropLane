import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function PaymentsListPage({
  params,
}: {
  params: Promise<{ direction: string; bucket: string }>;
}) {
  const { direction, bucket } = await params;
  return renderProPortalSection("payments", [direction, bucket]);
}
