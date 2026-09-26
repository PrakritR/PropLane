/**
 * Static "Seattle Homes" fixture data for the home page's product panels
 * (`lifecycle-rows.tsx`, `switch-steps.tsx`, `codex-hero-window.tsx`).
 *
 * Captain 2026-09-26: the marketing site no longer embeds the live `/demo`
 * sandbox — these panels render the REAL portal row/list/dashboard
 * components (see `product-mock/panels.tsx`) fed from this one hand-authored
 * dataset instead. Names, properties and numbers are the same fixed
 * "Seattle Homes" story used elsewhere in the demo bundle (Alder House,
 * Maple Duplex, Fremont Studio; Pacific Plumbing; the Test Resident/Test
 * Vendor canonical accounts) — see `src/lib/demo/demo-guided-data.ts` and
 * `docs/agents/demo-sandbox.md`. Never read live, never written to.
 */

export type TourFixtureRow = {
  id: string;
  guest: string;
  email: string;
  phone: string;
  place: string;
  when: string;
  format?: "virtual";
  reminder?: string;
  bucket: "pending" | "upcoming" | "past";
};

export const TOUR_ROWS: TourFixtureRow[] = [
  {
    id: "tour-fremont-jamie",
    guest: "Jamie P.",
    email: "jamie.p@example.com",
    phone: "(206) 555-0131",
    place: "Fremont Studio",
    when: "Sat, Sep 27 · 2:00 PM",
    reminder: "Reminder set for Friday",
    bucket: "upcoming",
  },
  {
    id: "tour-alder-morgan",
    guest: "Morgan Ito",
    email: "morgan.ito@example.com",
    phone: "(206) 555-0148",
    place: "Alder House · Room 2",
    when: "Sun, Sep 28 · 11:00 AM",
    bucket: "pending",
  },
  {
    id: "tour-maple-priya",
    guest: "Priya Shah",
    email: "priya.shah@example.com",
    phone: "(206) 555-0119",
    place: "Maple Duplex · Unit A",
    when: "Mon, Sep 29 · 4:30 PM",
    format: "virtual",
    bucket: "pending",
  },
  {
    id: "tour-fremont-past",
    guest: "Chris Nakamura",
    email: "chris.n@example.com",
    phone: "(206) 555-0107",
    place: "Fremont Studio",
    when: "Tue, Sep 16 · 1:00 PM",
    bucket: "past",
  },
];

export type ApplicationFixtureRow = {
  id: string;
  name: string;
  property: string;
  unit: string;
  email: string;
  submitted: string;
  sharedFact?: string;
  screening?: "flagged" | "passed";
  stage: string;
  bucket: "incomplete" | "pending" | "approved" | "rejected";
};

export const APPLICATION_ROWS: ApplicationFixtureRow[] = [
  {
    id: "app-maple-sample",
    name: "Sample Applicant",
    property: "Maple Duplex",
    unit: "Unit A",
    email: "sample.applicant@example.com",
    submitted: "Submitted Sep 24",
    stage: "Screening",
    screening: "flagged",
    bucket: "pending",
  },
  {
    id: "app-fremont-ethan",
    name: "Ethan Wright",
    property: "Fremont Studio",
    unit: "Studio",
    email: "ethan.wright@example.com",
    submitted: "Submitted Sep 23",
    sharedFact: "Shared · 2 residents · $1,100/mo each",
    stage: "Screening",
    screening: "flagged",
    bucket: "pending",
  },
  {
    id: "app-alder-dana",
    name: "Dana Reyes",
    property: "Alder House",
    unit: "Room 1",
    email: "dana.reyes@example.com",
    submitted: "Submitted Sep 12",
    stage: "Approved",
    screening: "passed",
    bucket: "approved",
  },
  {
    id: "app-maple-incomplete",
    name: "Sam Ostrowski",
    property: "Maple Duplex",
    unit: "Unit B",
    email: "sam.o@example.com",
    submitted: "Started Sep 25",
    stage: "Documents pending",
    bucket: "incomplete",
  },
  {
    id: "app-fremont-rejected",
    name: "Alexis Cole",
    property: "Fremont Studio",
    unit: "Studio",
    email: "alexis.cole@example.com",
    submitted: "Submitted Sep 5",
    stage: "Rejected",
    bucket: "rejected",
  },
];

export type LeaseFixtureRow = {
  id: string;
  resident: string;
  email: string;
  place: string;
  stage: string;
  updated: string;
  bucket: "manager" | "resident" | "signed" | "completed";
};

export const LEASE_ROWS: LeaseFixtureRow[] = [
  {
    id: "lease-alder-test-resident",
    resident: "Test Resident",
    email: "resident@test.proplane.local",
    place: "Alder House · Room 1",
    stage: "Fully Signed",
    updated: "Sep 20",
    bucket: "completed",
  },
  {
    id: "lease-maple-dana",
    resident: "Dana Reyes",
    email: "dana.reyes@example.com",
    place: "Maple Duplex · Unit A",
    stage: "Manager signature pending",
    updated: "Sep 24",
    bucket: "signed",
  },
  {
    id: "lease-fremont-jamie",
    resident: "Jamie P.",
    email: "jamie.p@example.com",
    place: "Fremont Studio",
    stage: "Resident signature pending",
    updated: "Sep 25",
    bucket: "resident",
  },
  {
    id: "lease-alder-morgan",
    resident: "Morgan Ito",
    email: "morgan.ito@example.com",
    place: "Alder House · Room 2",
    stage: "Manager review",
    updated: "Sep 26",
    bucket: "manager",
  },
];

export type PaymentFixtureRow = {
  id: string;
  resident: string;
  chargeTitle: string;
  property: string;
  due: string;
  amount: string;
  tone?: "ok" | "bad";
  bucket: "pending" | "overdue" | "paid";
};

export const PAYMENT_ROWS: PaymentFixtureRow[] = [
  {
    id: "charge-alder-current",
    resident: "Test Resident",
    chargeTitle: "September rent",
    property: "Alder House",
    due: "Due Sep 1",
    amount: "$3,200.00",
    tone: "bad",
    bucket: "overdue",
  },
  {
    id: "charge-maple-dana",
    resident: "Dana Reyes",
    chargeTitle: "October rent",
    property: "Maple Duplex",
    due: "Due Oct 1",
    amount: "$1,850.00",
    bucket: "pending",
  },
  {
    id: "charge-fremont-jamie",
    resident: "Jamie P.",
    chargeTitle: "October rent",
    property: "Fremont Studio",
    due: "Due Oct 1",
    amount: "$1,400.00",
    bucket: "pending",
  },
  {
    id: "charge-alder-august",
    resident: "Test Resident",
    chargeTitle: "August rent",
    property: "Alder House",
    due: "Paid Aug 1",
    amount: "$3,200.00",
    tone: "ok",
    bucket: "paid",
  },
];

export type ServiceFixtureRow = {
  id: string;
  title: string;
  kind: "add-on" | "maintenance";
  resident: string;
  property: string;
  detail: string;
  state: "open" | "scheduled" | "done" | "declined";
};

export const SERVICE_ROWS: ServiceFixtureRow[] = [
  {
    id: "wo-maple-heat",
    title: "No hot water",
    kind: "maintenance",
    resident: "Dana Reyes",
    property: "Maple Duplex",
    detail: "Reported this morning",
    state: "open",
  },
  {
    id: "wo-alder-faucet",
    title: "Kitchen faucet drip",
    kind: "maintenance",
    resident: "Test Resident",
    property: "Alder House",
    detail: "Pacific Plumbing · Thu 10:00 AM – 12:00 PM · $90.00 change order",
    state: "scheduled",
  },
  {
    id: "req-fremont-parking",
    title: "Parking spot",
    kind: "add-on",
    resident: "Jamie P.",
    property: "Fremont Studio",
    detail: "Approved · $45/mo",
    state: "done",
  },
  {
    id: "req-maple-storage",
    title: "Storage unit",
    kind: "add-on",
    resident: "Sam Chen",
    property: "Maple Duplex",
    detail: "Declined · no units available",
    state: "declined",
  },
];

/** The hero's dashboard panel — Occupancy 67%, rent collected $3,250 of
 * $6,450, three properties, "Needs attention", "Upcoming" (captain
 * 2026-09-26's exact numbers for the redesigned static hero). */
export const DASHBOARD_KPIS = {
  occupancy: { value: "67%", unit: "6 / 9 rooms" },
  rentCollected: { value: "$3,250", unit: "of $6,450 due" },
  openRequests: { value: "2", unit: "1 urgent" },
  applicationsReady: { value: "2", unit: "2 properties" },
};

export const DASHBOARD_ATTENTION = [
  { id: "att-app-maple", title: "Review Sample Applicant", detail: "Maple Duplex · screening flagged", actionLabel: "Review" as const, href: "#", tone: "pending" as const },
  { id: "att-wo-maple", title: "Dispatch a vendor", detail: "Maple Duplex · No hot water", actionLabel: "Review" as const, href: "#", tone: "danger" as const },
  { id: "att-lease-fremont", title: "Countersign Jamie P.'s lease", detail: "Fremont Studio · resident signed", actionLabel: "Sign" as const, href: "#", tone: "pending" as const },
];

/** A sensible wall-clock time N days out — never a raw `Date.now()` offset,
 * which lands on whatever minute the page happened to load
 * (`docs/agents/lavish-plan-standard.md`'s "sensible times"). */
function atTime(daysFromToday: number, hour: number, minute = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
export const DASHBOARD_UPCOMING = [
  { id: "up-tour-fremont", kind: "Tour", title: "Jamie P.", detail: "Fremont Studio", at: atTime(1, 14, 0), href: "#" },
  { id: "up-tour-alder", kind: "Tour", title: "Morgan Ito", detail: "Alder House · Room 2", at: atTime(2, 11, 0), href: "#" },
  { id: "up-service-maple", kind: "Maintenance", title: "Pacific Plumbing", detail: "Maple Duplex", at: atTime(3, 10, 0), href: "#" },
];

export const DASHBOARD_PROPERTIES = [
  { id: "prop-alder", title: "Alder House", address: "5259 Brooklyn Ave", spacesLabel: "3 rooms", rentLabel: "$3,200/mo" },
  { id: "prop-maple", title: "Maple Duplex", address: "1412 Maple Ct", spacesLabel: "4 rooms", rentLabel: "$1,850/mo" },
  { id: "prop-fremont", title: "Fremont Studio", address: "3301 Fremont Ave N", spacesLabel: "1 room", rentLabel: "$1,400/mo" },
];
