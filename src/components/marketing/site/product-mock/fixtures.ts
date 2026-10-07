/**
 * Static "Seattle Homes" fixture data for the home page's product panels
 * (`lifecycle-rows.tsx`, `switch-steps.tsx`, `codex-hero-window.tsx`).
 *
 * Captain 2026-09-26: the marketing site no longer embeds the live `/demo`
 * sandbox — these panels render the REAL portal row/list/dashboard
 * components (see `product-mock/panels.tsx`) fed from this one hand-authored
 * dataset instead. Properties (Alder House, Maple Duplex, Fremont Studio)
 * match the fixed "Seattle Homes" story used elsewhere in the demo bundle
 * (`src/lib/demo/demo-guided-data.ts`, `docs/agents/demo-sandbox.md`);
 * residents are named fixture people, never the canonical "Test Resident"
 * QA account (integrator review, 2026-09-26) and never a locked live listing
 * address. Each tab carries 4-6 rows so a panel's default view is always
 * full, never empty white space. Never read live, never written to.
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
    id: "tour-alder-noah",
    guest: "Noah Kessler",
    email: "noah.kessler@example.com",
    phone: "(206) 555-0163",
    place: "Alder House · Room 3",
    when: "Sat, Sep 27 · 4:00 PM",
    bucket: "upcoming",
  },
  {
    id: "tour-maple-zoe",
    guest: "Zoe Patterson",
    email: "zoe.patterson@example.com",
    phone: "(206) 555-0172",
    place: "Maple Duplex · Unit B",
    when: "Mon, Sep 29 · 10:00 AM",
    bucket: "upcoming",
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
    id: "app-alder-mason",
    name: "Mason Clark",
    property: "Alder House",
    unit: "Room 3",
    email: "mason.clark@example.com",
    submitted: "Submitted Sep 22",
    stage: "Screening",
    screening: "passed",
    bucket: "pending",
  },
  {
    id: "app-maple-olivia",
    name: "Olivia Brooks",
    property: "Maple Duplex",
    unit: "Unit B",
    email: "olivia.brooks@example.com",
    submitted: "Submitted Sep 21",
    stage: "Documents complete",
    bucket: "pending",
  },
  {
    id: "app-maple-dana",
    name: "Dana Reyes",
    property: "Maple Duplex",
    unit: "Unit A",
    email: "dana.reyes@example.com",
    submitted: "Submitted Sep 12",
    stage: "Approved",
    screening: "passed",
    bucket: "approved",
  },
  {
    id: "app-alder-liam",
    name: "Liam Foster",
    property: "Alder House",
    unit: "Room 1",
    email: "liam.foster@example.com",
    submitted: "Submitted Aug 18",
    stage: "Approved",
    screening: "passed",
    bucket: "approved",
  },
  {
    id: "app-fremont-luis",
    name: "Luis Ortega",
    property: "Fremont Studio",
    unit: "Studio",
    email: "luis.ortega@example.com",
    submitted: "Submitted Sep 10",
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
    id: "app-alder-incomplete",
    name: "Ava Sullivan",
    property: "Alder House",
    unit: "Room 2",
    email: "ava.sullivan@example.com",
    submitted: "Started Sep 25",
    stage: "Photo ID pending",
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
    id: "lease-alder-liam",
    resident: "Liam Foster",
    email: "liam.foster@example.com",
    place: "Alder House · Room 1",
    stage: "Fully Signed",
    updated: "Sep 20",
    bucket: "completed",
  },
  {
    id: "lease-maple-maya",
    resident: "Maya Chen",
    email: "maya.chen@example.com",
    place: "Maple Duplex · Unit B",
    stage: "Fully Signed",
    updated: "Sep 14",
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
    id: "lease-fremont-luis",
    resident: "Luis Ortega",
    email: "luis.ortega@example.com",
    place: "Fremont Studio",
    stage: "Manager signature pending",
    updated: "Sep 23",
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
  {
    id: "lease-alder-mason",
    resident: "Mason Clark",
    email: "mason.clark@example.com",
    place: "Alder House · Room 3",
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
    id: "charge-alder-liam-current",
    resident: "Liam Foster",
    chargeTitle: "September rent",
    property: "Alder House",
    due: "Due Sep 1",
    amount: "$1,650.00",
    tone: "bad",
    bucket: "overdue",
  },
  {
    id: "charge-maple-maya-current",
    resident: "Maya Chen",
    chargeTitle: "September rent",
    property: "Maple Duplex",
    due: "Due Sep 1",
    amount: "$1,850.00",
    tone: "bad",
    bucket: "overdue",
  },
  {
    id: "charge-alder-liam-october",
    resident: "Liam Foster",
    chargeTitle: "October rent",
    property: "Alder House",
    due: "Due Oct 1",
    amount: "$1,650.00",
    bucket: "pending",
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
    id: "charge-fremont-luis-paid",
    resident: "Luis Ortega",
    chargeTitle: "August rent",
    property: "Fremont Studio",
    due: "Paid Aug 1",
    amount: "$1,400.00",
    tone: "ok",
    bucket: "paid",
  },
  {
    id: "charge-alder-liam-august",
    resident: "Liam Foster",
    chargeTitle: "August rent",
    property: "Alder House",
    due: "Paid Aug 1",
    amount: "$1,650.00",
    tone: "ok",
    bucket: "paid",
  },
  {
    id: "charge-maple-maya-august",
    resident: "Maya Chen",
    chargeTitle: "August rent",
    property: "Maple Duplex",
    due: "Paid Aug 1",
    amount: "$1,850.00",
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
    id: "req-alder-storage",
    title: "Storage locker",
    kind: "add-on",
    resident: "Liam Foster",
    property: "Alder House",
    detail: "Requested this morning",
    state: "open",
  },
  {
    id: "wo-alder-faucet",
    title: "Kitchen faucet drip",
    kind: "maintenance",
    resident: "Liam Foster",
    property: "Alder House",
    detail: "Pacific Plumbing · Thu 10:00 AM – 12:00 PM · $90.00 change order",
    state: "scheduled",
  },
  {
    id: "wo-maple-lockout",
    title: "Locked out — front door",
    kind: "maintenance",
    resident: "Maya Chen",
    property: "Maple Duplex",
    detail: "Cascade Locksmiths · Today 3:00 PM – 4:00 PM",
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
    id: "wo-fremont-blinds",
    title: "Broken blinds",
    kind: "maintenance",
    resident: "Luis Ortega",
    property: "Fremont Studio",
    detail: "Completed Sep 18",
    state: "done",
  },
  {
    id: "wo-alder-smoke",
    title: "Smoke detector battery",
    kind: "maintenance",
    resident: "Liam Foster",
    property: "Alder House",
    detail: "Completed Sep 9",
    state: "done",
  },
  {
    id: "wo-maple-drain",
    title: "Slow bathroom drain",
    kind: "maintenance",
    resident: "Maya Chen",
    property: "Maple Duplex",
    detail: "Pacific Plumbing · Completed Sep 12",
    state: "done",
  },
  {
    id: "wo-fremont-disposal",
    title: "Garbage disposal repair",
    kind: "maintenance",
    resident: "Luis Ortega",
    property: "Fremont Studio",
    detail: "Pacific Plumbing · Completed Sep 22",
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
  { id: "prop-alder", title: "Alder House", address: "210 Alder St", spacesLabel: "3 rooms", rentLabel: "$1,650/mo" },
  { id: "prop-maple", title: "Maple Duplex", address: "1412 Maple Ct", spacesLabel: "4 rooms", rentLabel: "$1,850/mo" },
  { id: "prop-fremont", title: "Fremont Studio", address: "3301 Fremont Ave N", spacesLabel: "1 room", rentLabel: "$1,400/mo" },
];

export type CommMessageFixture = {
  id: string;
  author: string;
  body: string;
  at: string;
  direction: "inbound" | "outbound";
  channel?: "email" | "sms";
};

export type CommConversationFixture = {
  id: string;
  name: string;
  subtitle: string;
  preview: string;
  time: string;
  unread?: boolean;
  segment: "active" | "archived";
  messages: CommMessageFixture[];
};

/** Communication row fixtures — real terminology only ("Service request
 * #____", never "Job #" or "work order"; `bid` is real product vocabulary —
 * `tests/unit/services-vocabulary.test.ts`, `docs/agents/communication-inbox.md`). */
export const COMM_CONVERSATIONS: CommConversationFixture[] = [
  {
    id: "comm-jamie",
    name: "Jamie P.",
    subtitle: "Fremont Studio · Prospect",
    preview: "2:00 PM works great, thank you!",
    time: "10:05 AM",
    unread: true,
    segment: "active",
    messages: [
      { id: "m1", author: "Jamie P.", body: "Hi! Is the studio still available? Could I see it Saturday afternoon?", at: "Sat 10:02 AM", direction: "inbound", channel: "sms" },
      { id: "m2", author: "You", body: "Yes — it's available from Oct 1 at $1,400/mo. Saturday works: 1:00, 2:00 or 3:30 PM.", at: "10:03 AM", direction: "outbound", channel: "sms" },
      { id: "m3", author: "Jamie P.", body: "2:00 PM works great, thank you!", at: "10:05 AM", direction: "inbound", channel: "sms" },
    ],
  },
  {
    id: "comm-dana",
    name: "Dana Reyes",
    subtitle: "Maple Duplex · Resident",
    preview: "Service request #1042 · Pacific Plumbing booked Thu 10–12",
    time: "8:41 AM",
    segment: "active",
    messages: [
      { id: "m1", author: "Dana Reyes", body: "Hi, the kitchen faucet has been dripping for two days. Can someone take a look?", at: "Tue 8:41 AM", direction: "inbound", channel: "email" },
      { id: "m2", author: "You", body: "Service request #1042 is open — Pacific Plumbing is booked for Thursday between 10 and 12.", at: "8:50 AM", direction: "outbound", channel: "email" },
    ],
  },
  {
    id: "comm-pacific",
    name: "Pacific Plumbing",
    subtitle: "Vendor · Service request #1042",
    preview: "Bid for the shut-off valve: $90 — OK to proceed?",
    time: "10:30 AM",
    segment: "active",
    messages: [
      { id: "m1", author: "Pacific Plumbing", body: "Running 20 min late for Maple Duplex. Is there a gate code?", at: "Thu 9:48 AM", direction: "inbound", channel: "sms" },
      { id: "m2", author: "You", body: "Gate code is 4471#. Dana confirmed she's home until noon.", at: "9:48 AM", direction: "outbound", channel: "sms" },
      { id: "m3", author: "Pacific Plumbing", body: "The shut-off valve is corroded — bid for the fix is $90. OK to proceed?", at: "10:30 AM", direction: "inbound", channel: "sms" },
    ],
  },
  {
    id: "comm-ethan",
    name: "Ethan Wright",
    subtitle: "Fremont Studio · Applicant",
    preview: "Thanks, just paid the application fee.",
    time: "Tue",
    segment: "archived",
    messages: [
      { id: "m1", author: "Ethan Wright", body: "Thanks, just paid the application fee.", at: "Tue 4:12 PM", direction: "inbound", channel: "email" },
    ],
  },
];

/** The hero's floating activity toast (`codex-hero-window.tsx`) — named
 * fixture residents only, never "Test Resident", never a "SAMPLE DATA" label
 * (integrator review, 2026-09-26). */
export const HERO_ACTIVITY_EVENTS = [
  { title: "Pacific Plumbing dispatched to Maple Duplex", detail: "No hot water · Thu 10–12 · resident notified", tag: "Done" },
  { title: "Tour booked with Jamie P.", detail: "Fremont Studio · Sat 2:00 PM", tag: "Confirmed" },
  { title: "Rent paid — $1,650", detail: "Liam Foster · Alder House · autopay", tag: "Paid" },
  { title: "Application approved", detail: "Dana Reyes · Alder House", tag: "Approved" },
];

/* ─────────────────────────────────────────────────────────────────────────
 * The rest of the demo's world — Properties, Residents, Calendar, Vendors for
 * the manager, plus the resident (Liam Foster, Alder House · Room 1) and the
 * vendor (Pacific Plumbing) portals. Every row below agrees with the rows
 * above: the same people, the same houses, the same charges and services.
 * Counts a panel prints are derived from these rows, never typed beside them.
 * ───────────────────────────────────────────────────────────────────────── */

/** The manager the workspace belongs to. */
export const MANAGER_NAME = "Avery Morgan";

export type PropertyFixtureRow = {
  id: string;
  title: string;
  street: string;
  neighborhood: string;
  rooms: number;
  attention?: string;
  stage: "listed" | "unlisted" | "draft";
};

export const PROPERTY_ROWS: PropertyFixtureRow[] = [
  { id: "prop-alder", title: "Alder House", street: "210 Alder St", neighborhood: "Central District", rooms: 3, stage: "listed" },
  { id: "prop-maple", title: "Maple Duplex", street: "1412 Maple Ct", neighborhood: "Ballard", rooms: 4, attention: "1 open service", stage: "listed" },
  { id: "prop-fremont", title: "Fremont Studio", street: "3301 Fremont Ave N", neighborhood: "Fremont", rooms: 1, stage: "listed" },
];

export type ResidentFixtureRow = {
  id: string;
  name: string;
  email: string;
  place: string;
  /** The `M/D/YYYY` lease start the real row prints. */
  leaseStart: string;
  shared?: string;
  status?: string;
  tab: "potential" | "current" | "past";
};

const POTENTIAL_STATUS: Record<string, string> = {
  incomplete: "Incomplete application",
  pending: "Pending review",
};

/** Potential residents ARE the open applications — derived, so Applications and Residents never disagree. */
const POTENTIAL_RESIDENTS: ResidentFixtureRow[] = APPLICATION_ROWS.filter(
  (a) => a.bucket === "pending" || a.bucket === "incomplete",
).map((a) => ({
  id: `res-potential-${a.id}`,
  name: a.name,
  email: a.email,
  place: `${a.unit} · ${a.property}`,
  leaseStart: "10/1/2025",
  shared: a.sharedFact,
  status: POTENTIAL_STATUS[a.bucket],
  tab: "potential" as const,
}));

export const RESIDENT_ROWS: ResidentFixtureRow[] = [
  ...POTENTIAL_RESIDENTS,
  { id: "res-liam", name: "Liam Foster", email: "liam.foster@example.com", place: "Room 1 · Alder House", leaseStart: "8/1/2025", tab: "current" },
  { id: "res-dana", name: "Dana Reyes", email: "dana.reyes@example.com", place: "Unit A · Maple Duplex", leaseStart: "10/1/2025", tab: "current" },
  { id: "res-maya", name: "Maya Chen", email: "maya.chen@example.com", place: "Unit B · Maple Duplex", leaseStart: "9/1/2025", tab: "current" },
  { id: "res-luis", name: "Luis Ortega", email: "luis.ortega@example.com", place: "Studio · Fremont Studio", leaseStart: "10/1/2025", tab: "current" },
  { id: "res-sam", name: "Sam Chen", email: "sam.chen@example.com", place: "Unit B · Maple Duplex", leaseStart: "9/1/2024", tab: "past" },
];

export type CalendarFixtureItem = {
  id: string;
  kind: "tour" | "service" | "task";
  /** `YYYY-MM-DD` — the demo week runs Mon Sep 22 – Sun Sep 28. */
  dateStr: string;
  startMin: number;
  durationMin: number;
  title: string;
  place: string;
  /** A tour request still waiting on the manager — drawn dashed. */
  requested?: boolean;
  assignee?: string;
};

export const CALENDAR_WEEK = ["2025-09-22", "2025-09-23", "2025-09-24", "2025-09-25", "2025-09-26", "2025-09-27", "2025-09-28"];
/** Thursday, mid-morning — the "today" the grid highlights (Pacific Plumbing is on site). */
export const CALENDAR_TODAY = "2025-09-25";
export const CALENDAR_NOW_MIN = 10 * 60 + 35;

export const CALENDAR_ITEMS: CalendarFixtureItem[] = [
  { id: "cal-lockout", kind: "service", dateStr: "2025-09-24", startMin: 15 * 60, durationMin: 60, title: "Cascade Locksmiths", place: "Maple Duplex", assignee: "Cascade Locksmiths" },
  { id: "cal-faucet", kind: "service", dateStr: "2025-09-25", startMin: 10 * 60, durationMin: 120, title: "Pacific Plumbing", place: "Alder House", assignee: "Pacific Plumbing" },
  { id: "cal-countersign", kind: "task", dateStr: "2025-09-26", startMin: 9 * 60, durationMin: 30, title: "Countersign Jamie P.'s lease", place: "Fremont Studio", assignee: MANAGER_NAME },
  { id: "cal-tour-jamie", kind: "tour", dateStr: "2025-09-27", startMin: 14 * 60, durationMin: 30, title: "Jamie P.", place: "Fremont Studio" },
  { id: "cal-tour-noah", kind: "tour", dateStr: "2025-09-27", startMin: 16 * 60, durationMin: 30, title: "Noah Kessler", place: "Alder House" },
  { id: "cal-tour-morgan", kind: "tour", dateStr: "2025-09-28", startMin: 11 * 60, durationMin: 30, title: "Morgan Ito", place: "Alder House", requested: true },
];

export type VendorDirectoryRow = {
  id: string;
  name: string;
  trade: string;
  phone: string;
  email: string;
  /** Services assigned in this workspace. */
  services: number;
  rank?: "Primary" | "Secondary" | "Inactive";
  /** Present only when the vendor has reviews — printed as "4.8 (6)". */
  rating?: string;
};

/** Pacific Plumbing's reviews — the vendor portal draws every one, and the
 * manager's vendor row prints the rating derived from these same rows. */
export type VendorReviewFixture = {
  id: string;
  stars: number;
  body: string;
  at: string;
  reply?: string;
};

export const VENDOR_REVIEWS: VendorReviewFixture[] = [
  { id: "rev-3", stars: 4, body: "Good work on the disposal. Arrived 20 minutes after the window started.", at: "Sep 22, 2025, 6:05 PM" },
  { id: "rev-1", stars: 5, body: "Showed up in the window, fixed the drain in one visit, and left the bathroom spotless.", at: "Sep 15, 2025, 4:12 PM", reply: "Thank you, glad it's running clear." },
  { id: "rev-2", stars: 5, body: "Clear quote up front and no surprises on the invoice.", at: "Sep 2, 2025, 11:40 AM", reply: "Appreciate it. Happy to help anytime." },
  { id: "rev-4", stars: 5, body: "Explained what had failed and what it would cost before touching anything.", at: "Aug 28, 2025, 2:31 PM" },
  { id: "rev-5", stars: 5, body: "Water heater flush done quickly. Would book again.", at: "Aug 20, 2025, 9:15 AM", reply: "Thanks for the kind words." },
  { id: "rev-6", stars: 5, body: "Polite, on time, and tidy.", at: "Aug 6, 2025, 5:48 PM" },
];

export const VENDOR_RATING = {
  count: VENDOR_REVIEWS.length,
  average: VENDOR_REVIEWS.reduce((sum, r) => sum + r.stars, 0) / VENDOR_REVIEWS.length,
};
const VENDOR_RATING_LABEL = `${VENDOR_RATING.average.toFixed(1)} (${VENDOR_RATING.count})`;

export const VENDOR_ROWS: VendorDirectoryRow[] = [
  { id: "vendor-pacific", name: "Pacific Plumbing", trade: "Plumbing", phone: "(206) 555-0142", email: "office@pacificplumbing.example", services: 3, rank: "Primary", rating: VENDOR_RATING_LABEL },
  { id: "vendor-cascade", name: "Cascade Locksmiths", trade: "Locksmith", phone: "(206) 555-0177", email: "dispatch@cascadelocks.example", services: 1, rank: "Secondary" },
  { id: "vendor-evergreen", name: "Evergreen Electric", trade: "Electrical", phone: "(206) 555-0156", email: "jobs@evergreenelectric.example", services: 0, rank: "Secondary" },
  { id: "vendor-rainier", name: "Rainier Cleaning", trade: "Cleaning", phone: "(206) 555-0124", email: "hello@rainiercleaning.example", services: 0, rank: "Inactive" },
];

export type CatalogVendorFixture = { id: string; name: string; trades: string; city: string; rating: string };
export const CATALOG_VENDORS: CatalogVendorFixture[] = [
  { id: "cat-puget-hvac", name: "Puget Sound HVAC", trades: "HVAC, Heating", city: "Seattle", rating: "4.8 (31)" },
  { id: "cat-emerald-handyman", name: "Emerald City Handyman", trades: "Handyman, Carpentry", city: "Seattle", rating: "4.7 (22)" },
  { id: "cat-lakeview-paint", name: "Lakeview Painting", trades: "Painting", city: "Shoreline", rating: "4.9 (17)" },
  { id: "cat-northwest-pest", name: "Northwest Pest Control", trades: "Pest control", city: "Seattle", rating: "4.6 (40)" },
];

/** The general area an offered vendor sees before they are hired — never the street. */
export const AREA_BY_PROPERTY: Record<string, string> = {
  "Alder House": "Central District, Seattle",
  "Maple Duplex": "Ballard, Seattle",
  "Fremont Studio": "Fremont, Seattle",
};

/* ── Resident portal: Liam Foster · Alder House · Room 1 ── */

export const RESIDENT_NAME = "Liam Foster";
export const RESIDENT_HOME = {
  property: "Alder House",
  address: "210 Alder St",
  room: "Room 1",
  rent: "$1,650",
  moveIn: "Aug 1, 2025",
  leaseSigned: "Sep 20, 3:00 PM",
};

export type ResidentFormFixture = {
  id: string;
  title: string;
  place: string;
  fact: string;
  blocks?: string;
  bucket: "pending" | "completed";
};
export const RESIDENT_FORMS: ResidentFormFixture[] = [
  { id: "form-movein", title: "Move-in details", place: "Alder House · Room 1", fact: "Due Oct 8", blocks: "Needed for move-in details", bucket: "pending" },
  { id: "form-insurance", title: "Renters insurance proof", place: "Alder House · Room 1", fact: "Not due yet", bucket: "pending" },
  { id: "form-rules", title: "House rules acknowledgment", place: "Alder House · Room 1", fact: "Submitted Sep 20", bucket: "completed" },
];

/** Liam's conversations — the manager and the automated rent reminder. */
export const RESIDENT_CONVERSATIONS: CommConversationFixture[] = [
  {
    id: "res-comm-avery",
    name: MANAGER_NAME,
    subtitle: "Alder House · Manager",
    preview: "Pacific Plumbing is booked Thursday between 10 and 12.",
    time: "8:50 AM",
    unread: true,
    segment: "active",
    messages: [
      { id: "m1", author: RESIDENT_NAME, body: "The kitchen faucet has been dripping for two days. Can someone take a look?", at: "Sep 23, 8:41 AM", direction: "outbound", channel: "email" },
      { id: "m2", author: MANAGER_NAME, body: "Service request #1042 is open. Pacific Plumbing is booked Thursday between 10 and 12.", at: "Sep 23, 8:50 AM", direction: "inbound", channel: "email" },
    ],
  },
  {
    id: "res-comm-rent",
    name: "Alder House",
    subtitle: "Automated · September rent",
    preview: "September rent of $1,650.00 was due Sep 1.",
    time: "Sep 3",
    segment: "active",
    messages: [
      { id: "m1", author: MANAGER_NAME, body: "September rent of $1,650.00 was due Sep 1. You can pay it from Payments.", at: "Sep 3, 9:00 AM", direction: "inbound", channel: "email" },
    ],
  },
  {
    id: "res-comm-old",
    name: MANAGER_NAME,
    subtitle: "Alder House · Manager",
    preview: "Welcome to Alder House. Your move-in details are ready.",
    time: "Aug 1",
    segment: "archived",
    messages: [
      { id: "m1", author: MANAGER_NAME, body: "Welcome to Alder House. Your move-in details are ready.", at: "Aug 1, 10:00 AM", direction: "inbound", channel: "email" },
    ],
  },
];

/* ── Vendor portal: Pacific Plumbing ── */

export const VENDOR_NAME = "Pacific Plumbing";

export type VendorServiceFixture = {
  id: string;
  title: string;
  /** Property name — the area-only line is derived for jobs the vendor is not hired on yet. */
  property: string;
  unit?: string;
  hired: boolean;
  fact: string;
  factIcon: "clock" | "sparkles" | "calendar" | "check";
  figure?: string;
  state: "open" | "assigned" | "scheduled" | "completed";
};

export const VENDOR_SERVICES: VendorServiceFixture[] = [
  { id: "vsvc-hotwater", title: "No hot water", property: "Maple Duplex", hired: false, fact: "Requested by Avery Morgan · answer by Sep 26", factIcon: "sparkles", figure: "$250 budget", state: "open" },
  { id: "vsvc-faucet", title: "Kitchen faucet drip", property: "Alder House", unit: "Room 1", hired: true, fact: "Thu, Sep 25 · 10am", factIcon: "calendar", figure: "$90", state: "scheduled" },
  { id: "vsvc-drain", title: "Slow bathroom drain", property: "Maple Duplex", unit: "Unit B", hired: true, fact: "Paid Sep 15", factIcon: "check", figure: "$140", state: "completed" },
  { id: "vsvc-disposal", title: "Garbage disposal repair", property: "Fremont Studio", hired: true, fact: "Invoice sent", factIcon: "check", figure: "$210", state: "completed" },
];

export type VendorPaymentFixture = {
  id: string;
  title: string;
  place: string;
  date: string;
  status: string;
  amount: string;
};
export const VENDOR_PAYMENTS: VendorPaymentFixture[] = [
  { id: "vpay-disposal", title: "INV-1015", place: "Fremont Studio", date: "Sep 24, 2025", status: "Submitted", amount: "$210.00" },
  { id: "vpay-drain", title: "INV-1012", place: "Maple Duplex · Unit B", date: "Sep 15, 2025", status: "Paid", amount: "$140.00" },
  { id: "vpay-heater", title: "INV-1009", place: "Alder House", date: "Aug 28, 2025", status: "Paid", amount: "$95.00" },
];

export const VENDOR_CONVERSATIONS: CommConversationFixture[] = [
  {
    id: "vend-comm-avery",
    name: MANAGER_NAME,
    subtitle: "Seattle Homes · Manager",
    preview: "OK to proceed with the $90 change order.",
    time: "10:34 AM",
    unread: true,
    segment: "active",
    messages: [
      { id: "m1", author: VENDOR_NAME, body: "Running 20 min late for Maple Duplex. Is there a gate code?", at: "Sep 25, 9:48 AM", direction: "outbound", channel: "sms" },
      { id: "m2", author: MANAGER_NAME, body: "Gate code is 4471#. Dana confirmed she's home until noon.", at: "Sep 25, 9:48 AM", direction: "inbound", channel: "sms" },
      { id: "m3", author: VENDOR_NAME, body: "The shut-off valve is corroded. The bid for the fix is $90. OK to proceed?", at: "Sep 25, 10:30 AM", direction: "outbound", channel: "sms" },
      { id: "m4", author: MANAGER_NAME, body: "OK to proceed with the $90 change order.", at: "Sep 25, 10:34 AM", direction: "inbound", channel: "sms" },
    ],
  },
  {
    id: "vend-comm-invoice",
    name: MANAGER_NAME,
    subtitle: "Seattle Homes · INV-1012",
    preview: "Paid. It will reach your bank in two business days.",
    time: "Sep 15",
    segment: "active",
    messages: [
      { id: "m1", author: MANAGER_NAME, body: "Paid. It will reach your bank in two business days.", at: "Sep 15, 4:30 PM", direction: "inbound", channel: "email" },
    ],
  },
  {
    id: "vend-comm-old",
    name: MANAGER_NAME,
    subtitle: "Seattle Homes · Manager",
    preview: "Thanks for the quick turnaround on the disposal.",
    time: "Sep 22",
    segment: "archived",
    messages: [
      { id: "m1", author: MANAGER_NAME, body: "Thanks for the quick turnaround on the disposal.", at: "Sep 22, 5:10 PM", direction: "inbound", channel: "email" },
    ],
  },
];
