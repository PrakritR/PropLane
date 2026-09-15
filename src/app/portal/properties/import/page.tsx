import { PortfolioImportWizard } from "@/components/portal/portfolio-import-wizard";

/**
 * A static segment beats the `[stage]` dynamic route at the same level, so
 * this file — not `properties/[stage]/page.tsx` — serves `/portal/properties/import`.
 * It renders inside the shared `/portal` layout (sidebar, top bar) like every
 * other portal page, without going through `renderPortalSection`'s stage
 * routing. `?importId=` resumes an in-progress or completed import.
 */
export default async function PortfolioImportPage({
  searchParams,
}: {
  searchParams: Promise<{ importId?: string }>;
}) {
  const params = await searchParams;
  return <PortfolioImportWizard resumeImportId={params.importId?.trim() || undefined} />;
}
