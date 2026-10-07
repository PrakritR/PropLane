import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function CalendarViewPage({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  return renderProPortalSection("calendar", [view]);
}
