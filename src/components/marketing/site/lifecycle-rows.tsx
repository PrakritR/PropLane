import Link from "next/link";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { LifecycleFrame } from "@/components/marketing/site/lifecycle-frame";
import { SiteEyebrow, SiteHeading, SiteSection } from "@/components/marketing/site/primitives";
import type { DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { cn } from "@/lib/utils";

/**
 * "The best way to run a rental." — the product rows under the demo. Captain
 * 2026-10-06 (home demo redesign, Section map row 4): every row's screen is
 * drawn in Akhil's frame from the hero demo (`lifecycle-frame.tsx`): the
 * PropLane workspace window on the page's wavy background, at one fixed size, with
 * the real portal panel for one tab inside it (`DemoPanel`,
 * `product-mock/demo-panels.tsx`); a long list scrolls inside the window and never
 * grows it. The phone is not drawn here: one phone stays on screen beside every row
 * (`resident-lifecycle-prototypes.tsx`). Rows alternate sides. Static fixtures only: no network
 * request, nothing saved (`docs/agents/marketing-mocks.md`).
 *
 * Every sentence below describes something the product does; check the area's
 * `docs/agents/*.md` before changing one.
 */

type LifecycleRowDef = {
  id: string;
  kicker: string;
  headline: string;
  body: string;
  linkLabel: string;
  portal: DemoPortal;
  tab: string;
};

const ROWS: LifecycleRowDef[] = [
  {
    id: "tours",
    kicker: "Tours",
    headline: "Never lose a lease to a missed showing.",
    body: "Prospects book only the slots you actually have open. Reminders go out on their own, and a no-show re-offers the slot instead of sitting dead on your calendar.",
    linkLabel: "See tours in PropLane",
    portal: "manager",
    tab: "tours",
  },
  {
    id: "applications",
    kicker: "Applications",
    headline: "A slow application is a month of vacancy.",
    body: "ID, income and references land in one place per applicant, with the fee collected up front. Co-applicants group together automatically, and nothing blocks on the slowest one.",
    linkLabel: "See applications in PropLane",
    portal: "manager",
    tab: "applications",
  },
  {
    id: "leasing",
    kicker: "Leasing",
    headline: "Stop chasing the one signature you're missing.",
    body: "Generate a lease straight from the approved application, e-sign with a real audit trail, and let the deposit charge go out the moment it's countersigned.",
    linkLabel: "See leasing in PropLane",
    portal: "manager",
    tab: "leases",
  },
  {
    id: "residents",
    kicker: "Residents & move-in",
    headline: "Move-in is a checklist, not a scramble.",
    body: "Potential, current and past residents sit in one list, each with their own record. Send a move-in form and see it come back before move-in day.",
    linkLabel: "See residents in PropLane",
    portal: "manager",
    tab: "residents",
  },
  {
    id: "payments",
    kicker: "Payments",
    headline: "Rent shouldn't need an hour of your month.",
    body: "Autopay and reminders run before the due date, late fees post from the ledger instead of by hand, and vendors get paid from the same balance — no separate books.",
    linkLabel: "See payments in PropLane",
    portal: "manager",
    tab: "payments",
  },
  {
    id: "services",
    kicker: "Services",
    headline: "A 2 AM leak shouldn't need a phone tree.",
    body: "Residents report issues with photos and get told at every step. Dispatch to your own vendor or compare quotes, and a change order always waits for your yes first.",
    linkLabel: "See services in PropLane",
    portal: "manager",
    tab: "services",
  },
  {
    id: "vendors",
    kicker: "Vendors",
    headline: "Vendors get the job, not a phone tree.",
    body: "A vendor sees the service, a budget and the general area, and answers with a quote. The street address opens only once you accept it.",
    linkLabel: "See the vendor portal",
    portal: "vendor",
    tab: "work-orders",
  },
  {
    id: "resident-portal",
    kicker: "Resident portal",
    headline: "Residents get their own portal.",
    body: "Rent, the lease, service requests and messages with you live in one place, on the web and in the iOS app.",
    linkLabel: "See the resident portal",
    portal: "resident",
    tab: "move-in",
  },
  {
    id: "calendar",
    kicker: "Calendar",
    headline: "Tours, services and tasks on one week.",
    body: "Everything with a time lands on one calendar, with the hours you take tours shown as open. Connect Google Calendar and it appears there too.",
    linkLabel: "See the calendar in PropLane",
    portal: "manager",
    tab: "calendar",
  },
  {
    id: "communication",
    kicker: "Communication",
    headline: "Every message, in one inbox — never three.",
    body: "Prospects, residents and vendors land in the same thread list. Reply in-app, by email or by text from one composer, and the record it's about is one click away.",
    linkLabel: "See Communication in PropLane",
    portal: "manager",
    tab: "communication",
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

  const panelCell = <LifecycleFrame portal={row.portal} tab={row.tab} label={row.kicker} />;

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
        flip ? "lg:grid-cols-[minmax(0,0.7fr)_minmax(0,0.3fr)]" : "lg:grid-cols-[minmax(0,0.3fr)_minmax(0,0.7fr)]",
      )}
    >
      <div className={cn("order-1", flip ? "lg:order-2" : "lg:order-1")}>{textCell}</div>
      <div className={cn("order-2 min-w-0", flip ? "lg:order-1" : "lg:order-2")}>{panelCell}</div>
    </div>
  );
}

/** "The best way to run a rental." — the product rows (see file docstring). */
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
