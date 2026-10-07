import { renderPortalSection } from "@/lib/render-portal-section/admin";
import { notFound } from "next/navigation";

/** Session/cookies-backed admin sections must not be statically prerendered. */
export const dynamic = "force-dynamic";

export default async function AdminSectionPage({
  params,
}: {
  params: Promise<{ section: string; tab?: string[] }>;
}) {
  const { section: rawSection, tab } = await params;
  const section = typeof rawSection === "string" ? rawSection.trim() : "";
  if (!section) notFound();
  const cleanTab = Array.isArray(tab) ? tab.filter((s) => typeof s === "string" && s.trim().length > 0) : undefined;
  return renderPortalSection("admin", section, cleanTab);
}
