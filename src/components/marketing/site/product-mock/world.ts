/**
 * The home demo's one sample world, as a function of the story's progress.
 *
 * `fixtures.ts` is the standing portfolio ("Seattle Homes": Alder House, Maple
 * Duplex, Fremont Studio and Willow Court). The guided demo adds one person on
 * top of it: Jordan, who asks about Room 3 at 61 Willow Court, tours,
 * applies, signs, moves in, pays rent and reports a leaking faucet. Every
 * portal reads the same `DemoStory`, so a manager's Applications tab, the
 * resident's Lease tab, the vendor's Services tab and the phone beside them can
 * never disagree about where Jordan is.
 *
 * Every count (tab badges, sidebar badges, dashboard cards, a property's open
 * services, a vendor's service count) is derived here from the rows that are
 * drawn, never typed beside them (`docs/agents/marketing-mocks.md`). Pure data,
 * no React, no network.
 */

import {
  APPLICATION_ROWS,
  CALENDAR_ITEMS,
  COMM_CONVERSATIONS,
  DASHBOARD_UPCOMING,
  LEASE_ROWS,
  MANAGER_NAME,
  PAYMENT_ROWS,
  PROPERTY_ROWS,
  RESIDENT_EMAIL,
  RESIDENT_FORMS,
  RESIDENT_HOME,
  RESIDENT_NAME,
  RESIDENT_SELF,
  RESIDENT_ROWS,
  SERVICE_ROWS,
  TOUR_ROWS,
  VENDOR_CONVERSATIONS,
  VENDOR_NAME,
  VENDOR_PAYMENTS,
  VENDOR_ROWS,
  VENDOR_SERVICES,
  atTime,
  type ApplicationFixtureRow,
  type CalendarFixtureItem,
  type CommConversationFixture,
  type CommMessageFixture,
  type LeaseFixtureRow,
  type PaymentFixtureRow,
  type PropertyFixtureRow,
  type ResidentFixtureRow,
  type ResidentFormFixture,
  type ServiceFixtureRow,
  type TourFixtureRow,
  type VendorDirectoryRow,
  type VendorPaymentFixture,
  type VendorServiceFixture,
} from "@/components/marketing/site/product-mock/fixtures";
import { kpiDelta, type KpiDelta } from "@/lib/dashboard-kpis";
import { buildManagerAttentionRows, type ManagerAttentionRow } from "@/lib/manager-attention-queue";

export type ServiceProgress = "none" | "open" | "quoted" | "scheduled" | "paid";

/** How far Jordan's story has gone. Every field is monotonic: later stages only add. */
export type DemoStory = {
  /** A tour time has been offered to Jordan. */
  tourOffered: boolean;
  /** Jordan answered YES. */
  tourAccepted: boolean;
  /** Jordan's application is in. */
  applicationSubmitted: boolean;
  applicationApproved: boolean;
  /** 0 manager review, 1 resident signature pending, 2 manager signature pending, 3 fully signed. */
  leaseStep: 0 | 1 | 2 | 3;
  rentPaid: boolean;
  /** Where the kitchen faucet service is. */
  service: ServiceProgress;
  /** The move-in form has been sent to Jordan. */
  formSent: boolean;
};

export const NO_STORY: DemoStory = {
  tourOffered: false,
  tourAccepted: false,
  applicationSubmitted: false,
  applicationApproved: false,
  leaseStep: 0,
  rentPaid: false,
  service: "none",
  formSent: false,
};

/** The manager story at a beat (`managerScript` supplies the inputs). */
export function managerStory(input: {
  tourOffered: boolean;
  tourAccepted: boolean;
  applicationSubmitted: boolean;
  applicationApproved: boolean;
  leaseStep: 0 | 1 | 2 | 3;
  rentPaid: boolean;
  vendorBooked: boolean;
  hasServiceRecord: boolean;
}): DemoStory {
  return {
    tourOffered: input.tourOffered,
    tourAccepted: input.tourAccepted,
    applicationSubmitted: input.applicationSubmitted,
    applicationApproved: input.applicationApproved,
    leaseStep: input.leaseStep,
    rentPaid: input.rentPaid,
    service: !input.hasServiceRecord ? "none" : input.vendorBooked ? "scheduled" : "open",
    formSent: false,
  };
}

const APPLIED: DemoStory = { ...NO_STORY, tourOffered: true, tourAccepted: true, applicationSubmitted: true };
const SIGNED: DemoStory = { ...APPLIED, applicationApproved: true, leaseStep: 3 };

/** What Jordan's own portal knows at each resident stage (the phone beside it shows the same moment). */
const RESIDENT_STORIES: Record<string, DemoStory> = {
  tour: { ...NO_STORY, tourOffered: true, tourAccepted: true },
  apply: APPLIED,
  sign: SIGNED,
  pay: { ...SIGNED, rentPaid: true, service: "scheduled", formSent: true },
};
/** What the vendor can see of the faucet service at each vendor stage. */
const VENDOR_STORIES: Record<string, DemoStory> = {
  offer: { ...SIGNED, rentPaid: true, service: "open" },
  quote: { ...SIGNED, rentPaid: true, service: "quoted" },
  visit: { ...SIGNED, rentPaid: true, service: "scheduled" },
  paid: { ...SIGNED, rentPaid: true, service: "paid" },
};

export function residentStory(stageId: string | undefined): DemoStory {
  return RESIDENT_STORIES[stageId ?? "pay"] ?? RESIDENT_STORIES.pay!;
}
export function vendorStory(stageId: string | undefined): DemoStory {
  return VENDOR_STORIES[stageId ?? "visit"] ?? VENDOR_STORIES.visit!;
}

/* ───────────────────────────── The manager's world ───────────────────────────── */

const JORDAN = { name: RESIDENT_NAME, email: RESIDENT_EMAIL, property: RESIDENT_HOME.property, unit: RESIDENT_HOME.room };
const JORDAN_PHONE = "(206) 555-0186";
const REPAIR = { title: "Kitchen faucet", vendor: VENDOR_NAME, visit: "Thu 9:00 AM", quote: "$180.00" };

const LEASE_STAGE = ["Manager review", "Resident signature pending", "Manager signature pending", "Fully Signed"] as const;
const LEASE_BUCKET = ["manager", "resident", "signed", "completed"] as const;

/** The seven periods before this one, for the KPI cards' bar history (the eighth bar is the figure itself). */
const OCCUPIED_HISTORY = [2, 2, 3, 3, 4, 4, 4];
const COLLECTED_HISTORY = [5200, 6100, 5800, 7400, 8100, 7900, 9100];
const OPENED_HISTORY = [1, 0, 2, 1, 3, 1, 1];
const LAST_MONTH = "last month";

export type DashboardCard = {
  value: string;
  unit: string;
  /** Eight values, oldest first; the last is the figure. Omitted for a card the real dashboard draws no bars on. */
  series?: number[];
  delta?: KpiDelta | null;
};
export type DashboardProperty = { id: string; title: string; address: string; spacesLabel: string; rentLabel: string };

export type DemoWorld = {
  story: DemoStory;
  tours: TourFixtureRow[];
  applications: ApplicationFixtureRow[];
  leases: LeaseFixtureRow[];
  payments: PaymentFixtureRow[];
  services: ServiceFixtureRow[];
  residents: ResidentFixtureRow[];
  properties: (PropertyFixtureRow & { attention?: string })[];
  calendar: CalendarFixtureItem[];
  vendors: (VendorDirectoryRow & { services: number })[];
  dashboard: {
    occupancy: DashboardCard;
    rentCollected: DashboardCard;
    openRequests: DashboardCard;
    applicationsReady: DashboardCard;
    attention: ManagerAttentionRow[];
    upcoming: typeof DASHBOARD_UPCOMING;
    properties: DashboardProperty[];
  };
  /** Sidebar badges, each the count of the rows its panel's first tab draws. */
  badges: { tours: number; applications: number; leases: number; payments: number; services: number };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const parseMoney = (text: string) => Number(text.replace(/[$,]/g, ""));

function build(story: DemoStory): DemoWorld {
  const tours: TourFixtureRow[] = [...TOUR_ROWS];
  if (story.tourOffered) {
    tours.unshift({
      id: "tour-willow-jordan",
      guest: JORDAN.name,
      email: JORDAN.email,
      phone: JORDAN_PHONE,
      place: `${JORDAN.property} · ${JORDAN.unit}`,
      when: "Thu, Sep 25 · 5:30 PM",
      reminder: story.tourAccepted ? "Reminder set for Thursday" : undefined,
      bucket: story.tourAccepted ? "upcoming" : "pending",
    });
  }

  const applications: ApplicationFixtureRow[] = [...APPLICATION_ROWS];
  if (story.applicationSubmitted) {
    applications.unshift({
      id: "app-willow-jordan",
      name: JORDAN.name,
      property: JORDAN.property,
      unit: JORDAN.unit,
      email: JORDAN.email,
      submitted: "Submitted Sep 25",
      stage: story.applicationApproved ? "Approved" : "Documents complete",
      screening: "passed",
      bucket: story.applicationApproved ? "approved" : "pending",
    });
  }

  const leases: LeaseFixtureRow[] = [...LEASE_ROWS];
  if (story.applicationApproved) {
    leases.unshift({
      id: "lease-willow-jordan",
      resident: JORDAN.name,
      email: JORDAN.email,
      place: `${JORDAN.property} · ${JORDAN.unit}`,
      stage: LEASE_STAGE[story.leaseStep],
      updated: "Sep 25",
      bucket: LEASE_BUCKET[story.leaseStep],
    });
  }

  const payments: PaymentFixtureRow[] = [...PAYMENT_ROWS];
  if (story.leaseStep === 3) {
    payments.unshift({
      id: "charge-willow-jordan-october",
      resident: JORDAN.name,
      chargeTitle: "October rent",
      property: JORDAN.property,
      due: story.rentPaid ? "Paid Sep 25" : "Due Oct 1",
      amount: "$1,080.00",
      tone: story.rentPaid ? "ok" : undefined,
      bucket: story.rentPaid ? "paid" : "pending",
    });
  }

  const services: ServiceFixtureRow[] = [...SERVICE_ROWS];
  if (story.service !== "none") {
    const base = { id: "wo-willow-faucet", title: REPAIR.title, kind: "maintenance" as const, resident: JORDAN.name, property: JORDAN.property };
    services.unshift(
      story.service === "scheduled"
        ? { ...base, detail: `${REPAIR.vendor} · ${REPAIR.visit} · ${REPAIR.quote}`, state: "scheduled" }
        : story.service === "paid"
          ? { ...base, detail: `${REPAIR.vendor} · Completed Oct 2 · ${REPAIR.quote}`, state: "done" }
          : story.service === "quoted"
            ? { ...base, detail: `${REPAIR.vendor} quoted ${REPAIR.quote} · ${REPAIR.visit}`, state: "open" }
            : { ...base, detail: "Reported today", state: "open" },
    );
  }

  const residents: ResidentFixtureRow[] = [...RESIDENT_ROWS];
  if (story.applicationSubmitted) {
    const movedIn = story.applicationApproved && story.leaseStep === 3;
    residents.unshift({
      id: "res-jordan",
      name: JORDAN.name,
      email: JORDAN.email,
      place: `${JORDAN.unit} · ${JORDAN.property}`,
      leaseStart: "10/1/2025",
      status: movedIn ? undefined : story.applicationApproved ? undefined : "Pending review",
      tab: movedIn ? "current" : "potential",
    });
  }

  const calendar: CalendarFixtureItem[] = [...CALENDAR_ITEMS];
  if (story.tourOffered) {
    calendar.push({
      id: "cal-tour-jordan",
      kind: "tour",
      dateStr: "2025-09-25",
      startMin: 17 * 60 + 30,
      durationMin: 30,
      title: JORDAN.name,
      place: JORDAN.property,
      requested: !story.tourAccepted,
    });
  }

  const properties = PROPERTY_ROWS.map((p) => {
    const open = services.filter((s) => s.property === p.title && s.kind === "maintenance" && s.state === "open").length;
    return { ...p, attention: open > 0 ? `${open} open ${open === 1 ? "service" : "services"}` : undefined };
  });

  const vendors = VENDOR_ROWS.map((v) => ({
    ...v,
    services: services.filter((s) => s.detail.startsWith(v.name)).length,
  }));

  /* Dashboard: every number is read off the rows above. */
  const totalRooms = properties.reduce((sum, p) => sum + p.rooms, 0);
  const occupied = residents.filter((r) => r.tab === "current").length;
  const september = payments.filter((p) => p.chargeTitle === "September rent");
  const dueTotal = september.reduce((sum, p) => sum + parseMoney(p.amount), 0);
  const collected = september.filter((p) => p.bucket === "paid").reduce((sum, p) => sum + parseMoney(p.amount), 0);
  const openServices = services.filter((s) => s.state === "open");
  const pendingApplications = applications.filter((a) => a.bucket === "pending");

  // The real queue builder (`buildManagerAttentionRows`), fed counts read off the rows above, so the
  // Dashboard's Needs attention and the assistant panel say what the product says, in its words.
  const overdue = payments.filter((p) => p.bucket === "overdue");
  const toSign = leases.filter((l) => l.bucket === "signed");
  const unreadThreads = COMM_CONVERSATIONS.filter((c) => c.segment === "active" && c.unread);
  const attention: ManagerAttentionRow[] = buildManagerAttentionRows({
    basePath: "#",
    overdueChargeCount: overdue.length,
    overdueBalanceLabel: money(overdue.reduce((sum, p) => sum + parseMoney(p.amount), 0)),
    pendingApplicationCount: pendingApplications.length,
    latestPendingApplicationProperty: pendingApplications[0]?.property,
    managerSignatureLeaseCount: toSign.length,
    pendingTourCount: 0,
    messagingNeedsSetup: false,
    messagingSettingsHref: "#",
    draftPropertyCount: 0,
    draftsHref: "#",
    unreadConversationCount: unreadThreads.length,
    latestUnreadSubject: unreadThreads[0]?.preview,
  });
  const upcoming = [...DASHBOARD_UPCOMING];
  if (story.tourAccepted) {
    upcoming.push({ id: "up-tour-jordan", kind: "Tour", title: JORDAN.name, detail: `${JORDAN.property} · ${JORDAN.unit}`, at: atTime(1, 17, 30), href: "#" });
  }
  upcoming.sort((a, b) => a.at - b.at);

  return {
    story,
    tours,
    applications,
    leases,
    payments,
    services,
    residents,
    properties,
    calendar,
    vendors,
    dashboard: {
      occupancy: {
        value: `${Math.round((occupied / totalRooms) * 100)}%`,
        unit: `${occupied} / ${totalRooms}`,
        series: [...OCCUPIED_HISTORY, occupied].map((n) => Math.round((n / totalRooms) * 100)),
        delta: kpiDelta([...OCCUPIED_HISTORY, occupied].map((n) => Math.round((n / totalRooms) * 100)), (n) => `${n} pts`, LAST_MONTH),
      },
      rentCollected: {
        value: money(collected),
        unit: `of ${money(dueTotal)} due`,
        series: [...COLLECTED_HISTORY, collected],
        delta: kpiDelta([...COLLECTED_HISTORY, collected], money, LAST_MONTH),
      },
      openRequests: {
        value: String(openServices.length),
        unit: "oldest 1 day",
        series: [...OPENED_HISTORY, openServices.length],
        delta: kpiDelta([...OPENED_HISTORY, openServices.length], String, LAST_MONTH, true),
      },
      applicationsReady: {
        value: String(pendingApplications.length),
        unit: plural(new Set(pendingApplications.map((a) => a.property)).size, "property", "properties"),
      },
      attention,
      upcoming,
      properties: properties.map((p) => ({
        id: p.id,
        title: p.title,
        address: p.street,
        spacesLabel: plural(p.rooms, "room"),
        rentLabel: p.rentLabel,
      })),
    },
    badges: {
      tours: tours.filter((t) => t.bucket === "pending").length,
      applications: pendingApplications.length,
      leases: toSign.length,
      payments: payments.filter((p) => p.bucket === "overdue").length,
      services: openServices.length,
    },
  };
}

const cache = new Map<string, DemoWorld>();

/** The sample world at a story's progress. Stable per story, so panels can memoize on it. */
export function worldFor(story: DemoStory = NO_STORY): DemoWorld {
  const key = JSON.stringify(story);
  let world = cache.get(key);
  if (!world) {
    world = build(story);
    cache.set(key, world);
  }
  return world;
}

/* ───────────────────────────── The resident's world ───────────────────────────── */

export type ResidentLeaseRow = { id: string; bucket: "pending" | "signed"; label: string; managerSigned: boolean };

/** Jordan's lease as his own portal draws it: nothing until the manager sends it, then Pending, then Signed. */
export function residentLeases(story: DemoStory): ResidentLeaseRow[] {
  if (!story.applicationApproved || story.leaseStep < 1) return [];
  if (story.leaseStep === 1) return [{ id: "lease-jordan", bucket: "pending", label: "Resident signature pending", managerSigned: false }];
  return [
    {
      id: "lease-jordan",
      bucket: "signed",
      label: story.leaseStep === 2 ? "Signed · Manager signature pending" : `Signed · ${RESIDENT_HOME.leaseSigned}`,
      managerSigned: story.leaseStep === 3,
    },
  ];
}

/** The Forms tab for Jordan: the move-in form once the manager has sent it, the rest of the packet beside it. */
export function residentForms(story: DemoStory): ResidentFormFixture[] {
  if (!story.formSent) return [];
  return RESIDENT_FORMS;
}

/** Everything in "My home" that depends on how far the move-in has gone. */
export function residentHomeProgress(story: DemoStory) {
  const unlocked = story.leaseStep === 3;
  return {
    unlocked,
    checklist: [
      { label: "Lease signed", done: story.leaseStep === 3 },
      { label: "Move-in charges paid", done: story.rentPaid },
      { label: "Move-in inspection photographed", done: false },
    ],
    inspections: [] as { title: string }[],
  };
}

export type PhoneLine = { kind: string; text?: string };

/** A thread drawn from the phone's own lines, so a portal's Communication tab says what the phone says. */
function threadFrom(
  lines: PhoneLine[],
  me: "in" | "out",
  names: { self: string; other: string },
): CommMessageFixture[] {
  const messages: CommMessageFixture[] = [];
  lines.forEach((line, index) => {
    if ((line.kind !== "in" && line.kind !== "out") || !line.text) return;
    const mine = line.kind === me;
    messages.push({
      id: `m${index}`,
      author: mine ? names.self : names.other,
      body: line.text,
      at: `Sep 25, ${10 + Math.floor(index / 2)}:${index % 2 ? "20" : "12"} AM`,
      direction: mine ? "outbound" : "inbound",
      channel: "sms",
    });
  });
  return messages;
}

/** Jordan's inbox. On his phone the manager's lines are "in"; in his portal they are inbound too. */
export function residentConversations(story: DemoStory, lines: PhoneLine[]): CommConversationFixture[] {
  const messages = threadFrom(lines, "out", { self: RESIDENT_SELF, other: MANAGER_NAME });
  const rows: CommConversationFixture[] = [];
  if (messages.length) {
    const last = messages[messages.length - 1]!;
    rows.push({
      id: "res-comm-avery",
      name: MANAGER_NAME,
      subtitle: `${RESIDENT_HOME.property} · Manager`,
      preview: last.body,
      time: "10:20 AM",
      unread: last.direction === "inbound",
      segment: "active",
      messages,
    });
  }
  if (story.leaseStep === 3) {
    rows.push({
      id: "res-comm-rent",
      name: RESIDENT_HOME.property,
      subtitle: "Automated · October rent",
      preview: `October rent of ${RESIDENT_HOME.rent}.00 is due Oct 1.`,
      time: "Sep 25",
      segment: "active",
      messages: [
        {
          id: "m1",
          author: MANAGER_NAME,
          body: `October rent of ${RESIDENT_HOME.rent}.00 is due Oct 1. You can pay it from Payments.`,
          at: "Sep 25, 9:00 AM",
          direction: "inbound",
          channel: "email",
        },
      ],
    });
  }
  return rows;
}

/* ───────────────────────────── The vendor's world ───────────────────────────── */

export const FAUCET_JOB_ID = "vsvc-willow-faucet";

/** Pacific Plumbing's services, plus the faucet job at whatever point the story has taken it. */
export function vendorServices(story: DemoStory): VendorServiceFixture[] {
  const base = { id: FAUCET_JOB_ID, title: REPAIR.title, property: JORDAN.property };
  switch (story.service) {
    case "open":
      return [
        { ...base, hired: false, fact: `Requested by ${MANAGER_NAME} · answer by Sep 26`, factIcon: "sparkles", state: "open" },
        ...VENDOR_SERVICES,
      ];
    case "quoted":
      return [{ ...base, hired: false, fact: "Quote sent · Thu 9:00 AM", factIcon: "clock", figure: "$180", state: "open" }, ...VENDOR_SERVICES];
    case "scheduled":
      return [{ ...base, unit: JORDAN.unit, hired: true, fact: "Thu, Oct 2 · 9am", factIcon: "calendar", figure: "$180", state: "scheduled" }, ...VENDOR_SERVICES];
    case "paid":
      return [{ ...base, unit: JORDAN.unit, hired: true, fact: "Paid Oct 2", factIcon: "check", figure: "$180", state: "completed" }, ...VENDOR_SERVICES];
    default:
      return VENDOR_SERVICES;
  }
}

export type VendorVisit = { id: string; dateStr: string; startMin: number; durationMin: number; title: string; place: string };

/** The faucet visit once the quote is accepted: next Thursday, in the week after the standing calendar's. */
export function vendorVisit(story: DemoStory): VendorVisit | null {
  if (story.service !== "scheduled" && story.service !== "paid") return null;
  return { id: "visit-willow-faucet", dateStr: "2025-10-02", startMin: 9 * 60, durationMin: 60, title: REPAIR.title, place: `${JORDAN.property} · ${JORDAN.unit}` };
}

export function vendorPayments(story: DemoStory): VendorPaymentFixture[] {
  if (story.service !== "paid") return VENDOR_PAYMENTS;
  return [
    { id: "vpay-willow-faucet", title: "INV-1016", place: `${JORDAN.property} · ${JORDAN.unit}`, date: "Oct 2, 2025", status: "Paid", amount: REPAIR.quote },
    ...VENDOR_PAYMENTS,
  ];
}

export function vendorConversations(lines: PhoneLine[]): CommConversationFixture[] {
  const messages = threadFrom(lines, "out", { self: VENDOR_NAME, other: "PropLane" });
  if (!messages.length) return VENDOR_CONVERSATIONS;
  const last = messages[messages.length - 1]!;
  return [
    {
      id: "vend-comm-offers",
      name: "PropLane",
      subtitle: `Service offers · ${REPAIR.title}`,
      preview: last.body,
      time: "10:20 AM",
      unread: last.direction === "inbound",
      segment: "active",
      messages,
    },
    ...VENDOR_CONVERSATIONS,
  ];
}
