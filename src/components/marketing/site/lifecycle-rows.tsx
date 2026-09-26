import Link from "next/link";
import type { ReactNode } from "react";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { SiteEyebrow, SiteHeading, SiteSection } from "@/components/marketing/site/primitives";
import {
  ApplicationsPanel,
  CommunicationPanel,
  LeasesPanel,
  PaymentsPanel,
  ServicesPanel,
  ToursPanel,
} from "@/components/marketing/site/product-mock/panels";
import { ProductPanelBackdrop } from "@/components/marketing/site/product-mock/shared";
import { cn } from "@/lib/utils";

/**
 * "The best way to run a rental." — captain 2026-09-26: a full redesign of
 * the old iframe-driven lifecycle rows, in the OpenAI Codex reference layout
 * (see the plan thread for the exact spec): a short text column (~30% width)
 * beside a large media panel (~60% width) — a soft blue/violet gradient
 * backdrop with the real portal window floating inside it, cropped at the
 * panel's bottom edge. Rows alternate sides. No bullets, no pills, no
 * perspective switch, no phone frames, no "Sample data" chip — one static,
 * interactive-but-non-saving desktop panel per row, built from the REAL
 * portal components (`product-mock/panels.tsx`) fed the fixed "Seattle
 * Homes" fixtures — never a live `/demo` iframe (`docs/agents/demo-sandbox.md`,
 * `docs/agents/marketing-mocks.md`).
 */

type LifecycleRowDef = {
  id: string;
  kicker: string;
  headline: string;
  body: string;
  linkLabel: string;
  panel: () => ReactNode;
};

const ROWS: LifecycleRowDef[] = [
  {
    id: "tours",
    kicker: "Tours",
    headline: "Never lose a lease to a missed showing.",
    body: "Prospects book only the slots you actually have open. Reminders go out on their own, and a no-show re-offers the slot instead of sitting dead on your calendar.",
    linkLabel: "See tours in PropLane",
    panel: () => <ToursPanel />,
  },
  {
    id: "applications",
    kicker: "Applications",
    headline: "A slow application is a month of vacancy.",
    body: "ID, income and references land in one place per applicant, with the fee collected up front. Co-applicants group together automatically, and nothing blocks on the slowest one.",
    linkLabel: "See applications in PropLane",
    panel: () => <ApplicationsPanel />,
  },
  {
    id: "leasing",
    kicker: "Leasing",
    headline: "Stop chasing the one signature you're missing.",
    body: "Generate a lease straight from the approved application, e-sign with a real audit trail, and let the deposit charge go out the moment it's countersigned.",
    linkLabel: "See leasing in PropLane",
    panel: () => <LeasesPanel />,
  },
  {
    id: "payments",
    kicker: "Payments",
    headline: "Rent shouldn't need an hour of your month.",
    body: "Autopay and reminders run before the due date, late fees post from the ledger instead of by hand, and vendors get paid from the same balance — no separate books.",
    linkLabel: "See payments in PropLane",
    panel: () => <PaymentsPanel />,
  },
  {
    id: "services",
    kicker: "Services",
    headline: "A 2 AM leak shouldn't need a phone tree.",
    body: "Residents report issues with photos and get told at every step. Dispatch to your own vendor or compare quotes, and a change order always waits for your yes first.",
    linkLabel: "See services in PropLane",
    panel: () => <ServicesPanel />,
  },
  {
    id: "communication",
    kicker: "Communication",
    headline: "Every message, in one inbox — never three.",
    body: "Prospects, residents and vendors land in the same thread list. Reply in-app, by email or by text from one composer, and the record it's about is one click away.",
    linkLabel: "See Communication in PropLane",
    panel: () => <CommunicationPanel />,
  },
];

function LifecycleRow({ row, flip }: { row: LifecycleRowDef; flip: boolean }) {
  const textCell = (
    <div className="flex flex-col lg:justify-end">
      <SiteEyebrow className="mb-2">{row.kicker}</SiteEyebrow>
      <h3 className="text-[clamp(1.35rem,2.2vw,1.6rem)] font-bold leading-[1.15] tracking-tight text-foreground">{row.headline}</h3>
      <p className="mt-3 text-[14.5px] leading-relaxed text-muted">{row.body}</p>
      <Link
        href={GET_STARTED_HREF}
        data-attr={`home-lifecycle-${row.id}`}
        className="mt-4 inline-flex items-center gap-1.5 text-[14.5px] font-bold text-primary hover:underline"
      >
        {row.linkLabel} <span aria-hidden>→</span>
      </Link>
    </div>
  );

  const panelCell = (
    <ProductPanelBackdrop mirror={flip} className="h-[300px] sm:h-[400px] lg:h-[460px]">
      {row.panel()}
    </ProductPanelBackdrop>
  );

  return (
    <div
      data-lifecycle-row={row.id}
      className={cn(
        "grid items-stretch gap-8 border-t border-border py-10 sm:gap-10 lg:py-14",
        "grid-cols-1",
        // The grid TRACK WIDTHS themselves have to swap with `flip`, not just
        // which cell sits in which DOM order — reusing the same
        // narrow-then-wide track list for every row (with only `order-*`
        // swapping which child renders where) left every row's wide track on
        // the right regardless of `flip` (captain's screenshot: every panel
        // on the right). Phone: always text first, then panel — `order-1`/
        // `order-2` below the `lg:` breakpoint never change with `flip`.
        flip ? "lg:grid-cols-[minmax(0,0.66fr)_minmax(0,0.34fr)]" : "lg:grid-cols-[minmax(0,0.34fr)_minmax(0,0.66fr)]",
      )}
    >
      <div className={cn("order-1", flip ? "lg:order-2" : "lg:order-1")}>{textCell}</div>
      <div className={cn("order-2", flip ? "lg:order-1" : "lg:order-2")}>{panelCell}</div>
    </div>
  );
}

/** "The best way to run a rental." — the six product rows (see file docstring). */
export function SiteLifecycleRows() {
  return (
    <SiteSection id="lifecycle" ariaLabelledBy="site-lifecycle-title">
      <div className="mx-auto mb-2 max-w-[640px] text-center">
        <SiteEyebrow>The lifecycle</SiteEyebrow>
        <SiteHeading id="site-lifecycle-title" className="mt-2">
          The best way to run a rental.
        </SiteHeading>
      </div>
      {ROWS.map((row, i) => (
        <LifecycleRow key={row.id} row={row} flip={i % 2 === 1} />
      ))}
    </SiteSection>
  );
}
