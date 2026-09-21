import { Suspense } from "react";
import { PortfolioImportPageClient } from "@/components/portal/portfolio-import/portfolio-import-page";

/**
 * A static segment beats the `[stage]` dynamic route at the same level, so
 * this file — not `properties/[stage]/page.tsx` — serves
 * `/portal/properties/import`. It renders inside the shared `/portal` layout
 * (sidebar, top bar) like every other portal page, without going through
 * `renderPortalSection`'s stage routing.
 */
export default function PortfolioImportPage() {
  return (
    <Suspense fallback={null}>
      <PortfolioImportPageClient />
    </Suspense>
  );
}
