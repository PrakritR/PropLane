"use client";

import { DemoRouteSlice } from "@/components/marketing/site/demo-route-slice";
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
 * A scaled slice of the REAL `/portal/properties/import` Review step —
 * `/demo?role=manager&section=import`, not a hand-drawn replica of it
 * (captain 2026-09-25: "NOTHING like the real portal"). The real three-step
 * flow is Upload → Review → Create (never the 5-step "match columns" wizard
 * this section used to invent); `/demo`'s import view renders that same
 * `PortfolioImportReviewStep` fed a bundled sample rent roll
 * (`demo-import-sample.ts`) — no upload, no network, no real write, ever.
 * See `docs/agents/portfolio-import.md`.
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2 lg:items-start">
        <div className="min-w-0">
          <div className="space-y-8">
            {STEPS.map((step) => (
              <div key={step.title} className="border-t border-border pt-5">
                <SiteEyebrow className="mb-2">{step.eyebrow}</SiteEyebrow>
                <h3 className="text-[19px] font-bold leading-snug tracking-tight text-foreground">{step.title}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{step.body}</p>
              </div>
            ))}
          </div>
          <SiteCtaPair primaryAttr="home-switch-get-started" secondaryAttr="home-switch-book-demo" className="mt-8" />
        </div>
        <div className="mx-auto w-full min-w-0 max-w-[540px] lg:mr-0">
          <DemoRouteSlice role="manager" section="import" height={620} label="Properties → Import review" />
        </div>
      </div>
    </SiteSection>
  );
}
