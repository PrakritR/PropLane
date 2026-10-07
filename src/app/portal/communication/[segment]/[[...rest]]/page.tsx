import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function CommunicationPage({
  params,
}: {
  params: Promise<{ segment: string; rest?: string[] }>;
}) {
  const { segment, rest } = await params;
  const threadId = rest?.[0]?.trim();
  return renderProPortalSection("communication", threadId ? [segment, threadId] : [segment]);
}
