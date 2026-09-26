"use client";

import { ImportReviewPanel } from "@/components/marketing/site/product-mock/panels";
import { ProductPanelBackdrop } from "@/components/marketing/site/product-mock/shared";
import { SiteCtaPair, SiteEyebrow, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";

type SwitchStep = { eyebrow: string; title: string; body: string };

const STEPS: SwitchStep[] = [
  {
    eyebrow: "Step 1",
    title: "Import your portfolio",
    body: "Drop a rent roll, an AppFolio or Buildium export, or lease PDFs. One read returns properties, rooms, residents, leases and open balances together.",
  },
  {
    eyebrow: "Step 2",
    title: "Review what the agent found",
    body: "One card per property, one row per resident, each citing the row or page it came from. Anything the file didn't say clearly is flagged, not guessed.",
  },
  {
    eyebrow: "Step 3",
    title: "Create it, invite when you're ready",
    body: "Properties, residents, leases, charges and tasks are created through the same paths every other create in PropLane uses. Nothing is emailed until you say so.",
  },
];

/**
 * Captain 2026-09-26: redesigned in the same Codex-style row as the
 * lifecycle rows below it — a compact left text column (the three steps,
 * condensed) beside the real `/portal/properties/import` Review step
 * (`PortfolioImportReviewStep`, fed the bundled sample rent roll
 * `demo-import-sample.ts`), desktop web UI only. No live `/demo` iframe, no
 * Manager/Resident/Vendor switch, no phone frame — see
 * `docs/agents/portfolio-import.md` and `docs/agents/marketing-mocks.md`.
 * The real three-step flow is Upload → Review → Create (never the 5-step
 * "match columns" wizard this section used to invent).
 */
export function SiteSwitchSteps() {
  return (
    <SiteSection tone="muted" ariaLabelledBy="site-switch-heading">
      <SiteIntro
        eyebrow="Switching"
        id="site-switch-heading"
        title="Up and running without starting over."
        lede="Your properties, units and residents come with you. Here's what switching to PropLane looks like."
      />
      <div className="grid grid-cols-1 items-stretch gap-8 lg:grid-cols-[minmax(0,0.34fr)_minmax(0,0.66fr)] lg:gap-10">
        <div className="flex flex-col justify-center gap-5">
          {STEPS.map((step) => (
            <div key={step.title} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
              <SiteEyebrow className="mb-1.5">{step.eyebrow}</SiteEyebrow>
              <h3 className="text-[16.5px] font-bold leading-snug tracking-tight text-foreground">{step.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{step.body}</p>
            </div>
          ))}
          <SiteCtaPair primaryAttr="home-switch-get-started" secondaryAttr="home-switch-book-demo" className="mt-1" />
        </div>
        <ProductPanelBackdrop className="h-[340px] sm:h-[440px] lg:h-[500px]">
          <ImportReviewPanel />
        </ProductPanelBackdrop>
      </div>
    </SiteSection>
  );
}
