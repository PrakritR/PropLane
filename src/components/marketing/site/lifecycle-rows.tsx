import Link from "next/link";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { LifecycleFrame } from "@/components/marketing/site/lifecycle-frame";
import { SiteEyebrow, SiteHeading, SiteSection } from "@/components/marketing/site/primitives";
import type { DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import type { PhoneScript } from "@/components/marketing/resident-lifecycle-script";
import { cn } from "@/lib/utils";

/**
 * "The best way to run a rental." — the product rows under the demo. Captain
 * 2026-10-06 (home demo redesign, Section map row 4): every row's screen is
 * drawn in Akhil's frame from the hero demo (`lifecycle-frame.tsx`): the
 * PropLane workspace window on the soft-blue stage, the real portal panel for
 * one tab inside it (`DemoPanel`, `product-mock/demo-panels.tsx`), and a phone
 * beside it wherever a second party is in the story (the prospect on Tours and
 * Communication, the vendor on Services and Vendors, the resident on the
 * resident portal). Rows alternate sides. Static fixtures only: no network
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
  phone?: PhoneScript;
};

const MANAGER_PHONE = { initials: "SH", name: "Seattle Homes", sub: "Fremont Studio" };

/** Static threads for the phones. They echo the fixtures the panel beside them draws. */
const TOUR_PHONE: PhoneScript = {
  caption: "Jamie’s phone",
  ...MANAGER_PHONE,
  items: [
    { kind: "time", text: "Saturday" },
    { kind: "in", text: "You’re booked for Fremont Studio on Saturday at 2:00 PM." },
    { kind: "card", icon: "calendar", eyebrow: "TOUR · FREMONT STUDIO", title: "Sat, Sep 27 · 2:00 PM", sub: "Reminder set for Friday" },
    { kind: "out", text: "2:00 PM works great, thank you!" },
  ],
};

const PROSPECT_THREAD_PHONE: PhoneScript = {
  caption: "Jamie’s phone",
  ...MANAGER_PHONE,
  items: [
    { kind: "time", text: "Saturday" },
    { kind: "out", text: "Hi! Is the studio still available? Could I see it Saturday afternoon?" },
    { kind: "in", text: "Yes, it’s available from Oct 1. Saturday works: 1:00, 2:00 or 3:30 PM." },
    { kind: "out", text: "2:00 PM works great, thank you!" },
  ],
};

const SERVICE_VENDOR_PHONE: PhoneScript = {
  caption: "Pacific Plumbing’s phone",
  initials: "PL",
  name: "PropLane",
  sub: "Service offers",
  items: [
    { kind: "time", text: "Service scheduled" },
    { kind: "in", text: "Avery Morgan accepted your quote. The address is now in your portal." },
    { kind: "card", icon: "wrench", eyebrow: "SERVICE · ALDER HOUSE", title: "Kitchen faucet drip", sub: "Thu, Sep 25 · 10am" },
  ],
};

const VENDOR_OFFER_PHONE: PhoneScript = {
  caption: "Marcus’s phone",
  initials: "PL",
  name: "PropLane",
  sub: "Service offers",
  items: [
    { kind: "time", text: "New service offer" },
    { kind: "in", text: "New service in Ballard, Seattle: no hot water. Reply with your quote and when you can come." },
    { kind: "out", text: "I can come Thursday at 10 AM. $220." },
    { kind: "in", text: "Quote received. Avery will confirm." },
  ],
};

const RESIDENT_PHONE: PhoneScript = {
  caption: "Jordan’s phone",
  initials: "AH",
  name: "Alder House",
  sub: "Automated · September rent",
  items: [
    { kind: "time", text: "Rent" },
    { kind: "in", text: "September rent of $1,650.00 was due Sep 1. You can pay it from Payments." },
    { kind: "card", icon: "card", eyebrow: "PAYMENTS · ALDER HOUSE", title: "September rent", sub: "$1,650.00" },
  ],
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
    phone: TOUR_PHONE,
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
    phone: SERVICE_VENDOR_PHONE,
  },
  {
    id: "vendors",
    kicker: "Vendors",
    headline: "Vendors get the job, not a phone tree.",
    body: "A vendor sees the service, a budget and the general area, and answers with a quote. The street address opens only once you accept it.",
    linkLabel: "See the vendor portal",
    portal: "vendor",
    tab: "services",
    phone: VENDOR_OFFER_PHONE,
  },
  {
    id: "resident-portal",
    kicker: "Resident portal",
    headline: "Residents get their own portal.",
    body: "Rent, the lease, service requests and messages with you live in one place, on the web and in the iOS app.",
    linkLabel: "See the resident portal",
    portal: "resident",
    tab: "home",
    phone: RESIDENT_PHONE,
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
    phone: PROSPECT_THREAD_PHONE,
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

  const panelCell = <LifecycleFrame portal={row.portal} tab={row.tab} phone={row.phone} label={row.kicker} />;

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
