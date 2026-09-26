/**
 * The dataset the `/demo` sandbox seeds into the browser-local portal stores.
 *
 * **Idle mode carries the "Seattle Homes" portfolio** (`buildDemoIdleSnapshot`,
 * captain 2026-09-25) — three properties, one leased resident, one pending
 * application, one upcoming tour — so the embedded manager Dashboard shows
 * real KPI numbers instead of "nothing here yet". It is deliberately NOT a
 * hand-invented fixture pretending to be someone's real account: every row is
 * scoped to the canonical `@test.proplane.local` sandbox identities, uses
 * `example.com` placeholder contacts for the one-off applicant/prospect, and
 * is the SAME object the DB seed writes onto the canonical manager account
 * (see below) — one source of truth, not two drifting ones.
 *
 * Two ways real data gets in:
 * - **This static baseline** (`buildDemoIdleSnapshot`) — the single seam, read
 *   by the seeder, the sandboxed agent context, and the canonical-portfolio DB
 *   seed (`scripts/seed-demo-manager-portfolio.ts` imports this exact
 *   function and passes it to `seedCanonicalDemoPortfolio`'s `opts.snapshot`).
 * - **Mirror.** `demo-portal-mirror.server.ts` overlays the canonical
 *   `@test.proplane.local` accounts' real portal rows when they have any
 *   (`/api/demo/portal-snapshot`, `DEMO_PORTAL_MIRROR_ENABLED` in
 *   `demo-mirror-flag.ts`) — once the DB seed script has run, the mirror and
 *   this static fallback carry the identical content, so which one actually
 *   serves a given request never matters visually.
 * - **Autoplay.** The "Run demo" walkthrough still builds its own property,
 *   application, and lease live through the real wizards
 *   (`demo-segment-playback.tsx`), starting from a genuinely blank slate
 *   (`buildDemoBlankSnapshot`) — unrelated to the idle baseline above.
 */
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import type { ManagerPromotionRow } from "@/lib/promotion-flyer";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { PortalBugFeedbackRow } from "@/lib/portal-bug-feedback";
import type { InboxMessage } from "@/lib/demo-admin-partner-inbox";
import type { UploadedOwnLease } from "@/lib/resident-lease-upload";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { VendorPayout } from "@/lib/vendor-payouts";
import type { PartnerInquiry, PlannedEvent } from "@/lib/demo-admin-scheduling";
import type { GuidedDemoStep } from "@/lib/demo/demo-guided";
import { CANONICAL_DEMO_RESIDENT_EMAIL, CANONICAL_DEMO_RESIDENT_NAME } from "@/lib/demo/demo-canonical-accounts";
import { DEMO_MANAGER_USER_ID, DEMO_RESIDENT_USER_ID } from "@/lib/demo/demo-session";

/** Calendar slice of a snapshot: tours, partner inquiries, manager availability. */
export type DemoScheduleSeed = {
  plannedEvents: PlannedEvent[];
  partnerInquiries: PartnerInquiry[];
  /** Availability slot keys (`YYYY-MM-DD:slotIndex`) per demo property id. */
  availabilityByPropertyId: Record<string, string[]>;
};

export type DemoDataSnapshot = {
  properties: MockProperty[];
  applications: DemoApplicantRow[];
  charges: HouseholdCharge[];
  rentProfiles: RecurringRentProfile[];
  leases: LeasePipelineRow[];
  workOrders: DemoManagerWorkOrderRow[];
  workOrderBids: WorkOrderBid[];
  vendorPayouts: VendorPayout[];
  vendors: ManagerVendorRow[];
  promotions: ManagerPromotionRow[];
  serviceRequests: ServiceRequest[];
  managerInbox: PersistedInboxThread[];
  residentInbox: PersistedInboxThread[];
  vendorInbox: PersistedInboxThread[];
  adminInbox: InboxMessage[];
  bugFeedback: PortalBugFeedbackRow[];
  schedule: DemoScheduleSeed;
  residentUploads: UploadedOwnLease[];
};

function emptySchedule(): DemoScheduleSeed {
  return { plannedEvents: [], partnerInquiries: [], availabilityByPropertyId: {} };
}

function emptySnapshot(): DemoDataSnapshot {
  return {
    properties: [],
    applications: [],
    charges: [],
    rentProfiles: [],
    leases: [],
    workOrders: [],
    workOrderBids: [],
    vendorPayouts: [],
    vendors: [],
    promotions: [],
    serviceRequests: [],
    managerInbox: [],
    residentInbox: [],
    vendorInbox: [],
    adminInbox: [],
    bugFeedback: [],
    schedule: emptySchedule(),
    residentUploads: [],
  };
}

/** Guided tour / Run demo — blank slate before autoplay creates a property. */
export function buildDemoBlankSnapshot(): DemoDataSnapshot {
  return emptySnapshot();
}

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Seattle Homes — the curated portfolio (captain 2026-09-25): three real
 * properties so the Dashboard's KPI cards, Needs attention, Upcoming, Your
 * properties and Cash flow panels all have something real to show instead of
 * "nothing here yet". Computed from the real day (not hardcoded dates) so an
 * "overdue" charge and an "upcoming" tour stay true for as long as this ships.
 *
 * This is the SAME "single seam" the module docstring points at: the DB seed
 * script (scripts/seed-demo-manager-portfolio.ts) imports this exact function
 * and writes it onto the canonical manager@test.proplane.local account, so
 * the mirror and this static fallback never diverge.
 */
function seattleHomesSnapshot(): DemoDataSnapshot {
  const managerUserId = DEMO_MANAGER_USER_ID;
  const residentUserId = DEMO_RESIDENT_USER_ID;
  const residentEmail = CANONICAL_DEMO_RESIDENT_EMAIL;
  const residentName = CANONICAL_DEMO_RESIDENT_NAME;

  const properties: MockProperty[] = [
    {
      id: "demo-prop-alder",
      title: "Alder House",
      buildingId: "demo-prop-alder",
      buildingName: "Alder House",
      unitLabel: "Whole house",
      tagline: "Craftsman near Green Lake",
      address: "1420 Alder St",
      zip: "98103",
      neighborhood: "Green Lake",
      beds: 4,
      baths: 2,
      rentLabel: "$3,200/mo",
      available: "Occupied",
      petFriendly: true,
      managerUserId,
    },
    {
      id: "demo-prop-maple",
      title: "Maple Duplex",
      buildingId: "demo-prop-maple",
      buildingName: "Maple Duplex",
      unitLabel: "Unit A",
      tagline: "Duplex near Ballard",
      address: "88 Maple Ave",
      zip: "98107",
      neighborhood: "Ballard",
      beds: 2,
      baths: 1,
      rentLabel: "$1,850/mo",
      available: "Now",
      petFriendly: false,
      managerUserId,
    },
    {
      id: "demo-prop-fremont",
      title: "Fremont Studio",
      buildingId: "demo-prop-fremont",
      buildingName: "Fremont Studio",
      unitLabel: "Studio",
      tagline: "Studio in the heart of Fremont",
      address: "3301 Fremont Ave N",
      zip: "98103",
      neighborhood: "Fremont",
      beds: 0,
      baths: 1,
      rentLabel: "$1,400/mo",
      available: "Now",
      petFriendly: false,
      managerUserId,
    },
  ];

  // Three occupied residents, one per property — the canonical demo resident
  // account on Alder House (a real, signable-in login), and two DISPLAY-ONLY
  // residents on Maple Duplex and Fremont Studio (residentUserId: null — no
  // backing login, same pattern the applicant/prospect rows below already
  // use for a name that shows up without inventing a real account).
  const RESIDENTS = [
    { propertyId: "demo-prop-alder", propertyLabel: "Alder House", unit: "Alder House", rent: 3200, email: residentEmail, name: residentName, userId: residentUserId },
    { propertyId: "demo-prop-maple", propertyLabel: "Maple Duplex", unit: "Maple Duplex · Unit A", rent: 1850, email: "sample.resident.maple@example.com", name: "Sample Resident", userId: null },
    { propertyId: "demo-prop-fremont", propertyLabel: "Fremont Studio", unit: "Fremont Studio", rent: 1400, email: "sample.resident.fremont@example.com", name: "Sample Resident", userId: null },
  ] as const;

  const leases: LeasePipelineRow[] = RESIDENTS.map((r, i) => ({
    id: `demo-lease-${r.propertyId}`,
    residentName: r.name,
    residentEmail: r.email,
    residentUserId: r.userId,
    managerUserId,
    propertyId: r.propertyId,
    unit: r.unit,
    stageLabel: i === 0 ? "Resident signature pending countersign" : "Fully signed",
    status: i === 0 ? "Resident Signature Pending" : "Fully Signed",
    updated: isoDate(daysAgo(60 - i)),
    updatedAtIso: daysAgo(60 - i).toISOString(),
    signedAtIso: i === 0 ? undefined : daysAgo(60 - i).toISOString(),
    fullySignedAt: i === 0 ? undefined : daysAgo(60 - i).toISOString(),
    bucket: i === 0 ? "resident" : "signed",
    pdfVersion: 1,
    notes: "",
    signedRentLabel: `$${r.rent.toLocaleString()}/mo`,
    thread: [],
  }));

  const rentProfiles: RecurringRentProfile[] = RESIDENTS.map((r) => ({
    id: `demo-rentprofile-${r.propertyId}`,
    residentEmail: r.email,
    residentName: r.name,
    residentUserId: r.userId,
    propertyId: r.propertyId,
    propertyLabel: r.propertyLabel,
    roomLabel: r.unit,
    managerUserId,
    // Dollars, not cents (RecurringRentProfile.monthlyRent) — this field
    // silently feeds the real monthly rent-charge generator; a cents value
    // here once produced two real $320,000.00 charge rows on the shared
    // account before it was caught.
    monthlyRent: r.rent,
    dueDay: 1,
    startMonth: isoDate(daysAgo(150)).slice(0, 7),
    active: true,
    updatedAt: daysAgo(60).toISOString(),
  }));

  // Six months of paid rent per resident (cash flow history), this month's
  // charge for each (two paid on time, Alder's overdue — the one "Needs
  // attention" item and the only unpaid balance on the books).
  const charges: HouseholdCharge[] = [];
  for (const r of RESIDENTS) {
    for (let monthsAgo = 6; monthsAgo >= 1; monthsAgo--) {
      const paidAt = daysAgo(monthsAgo * 30 - 2);
      charges.push({
        id: `demo-charge-${r.propertyId}-m${monthsAgo}`,
        createdAt: daysAgo(monthsAgo * 30).toISOString(),
        residentEmail: r.email,
        residentName: r.name,
        residentUserId: r.userId,
        propertyId: r.propertyId,
        propertyLabel: r.propertyLabel,
        managerUserId,
        kind: "rent",
        title: "Rent",
        amountLabel: `$${r.rent.toLocaleString()}.00`,
        balanceLabel: "$0.00",
        status: "paid",
        blocksLeaseUntilPaid: false,
        paidAmountCents: r.rent * 100,
        paidAt: paidAt.toISOString(),
        paidMethod: "bank",
        dueDay: 1,
        rentMonth: isoDate(daysAgo(monthsAgo * 30)).slice(0, 7),
      });
    }
    const isAlder = r.propertyId === "demo-prop-alder";
    charges.push({
      id: `demo-charge-${r.propertyId}-current`,
      createdAt: daysAgo(isAlder ? 6 : 20).toISOString(),
      residentEmail: r.email,
      residentName: r.name,
      residentUserId: r.userId,
      propertyId: r.propertyId,
      propertyLabel: r.propertyLabel,
      managerUserId,
      kind: "rent",
      title: "Rent",
      amountLabel: `$${r.rent.toLocaleString()}.00`,
      balanceLabel: isAlder ? `$${r.rent.toLocaleString()}.00` : "$0.00",
      status: isAlder ? "pending" : "paid",
      blocksLeaseUntilPaid: false,
      paidAmountCents: isAlder ? undefined : r.rent * 100,
      paidAt: isAlder ? undefined : daysAgo(18).toISOString(),
      paidMethod: isAlder ? undefined : "bank",
      dueDay: 1,
      dueDateLabel: isAlder ? isoDate(daysAgo(6)) : undefined,
      rentMonth: isoDate(daysAgo(isAlder ? 6 : 20)).slice(0, 7),
    });
  }

  // Two applications — one ready for review, one still in screening.
  const applications: DemoApplicantRow[] = [
    {
      id: "demo-app-maple",
      name: "Sample Applicant",
      email: "sample.applicant@example.com",
      property: "Maple Duplex",
      propertyId: "demo-prop-maple",
      assignedPropertyId: "demo-prop-maple",
      stage: "Application review",
      bucket: "pending",
      detail: "",
      managerUserId,
    },
    {
      id: "demo-app-fremont",
      name: "Sample Applicant Two",
      email: "sample.applicant.two@example.com",
      property: "Fremont Studio",
      propertyId: "demo-prop-fremont",
      assignedPropertyId: "demo-prop-fremont",
      stage: "Screening in progress",
      bucket: "pending",
      detail: "",
      managerUserId,
    },
  ];

  // Pacific Plumbing: the same vendor the home page's own Communication mock
  // names (site/story.tsx), for a consistent story between the two sections.
  const vendors: ManagerVendorRow[] = [
    {
      id: "demo-vendor-pacific-plumbing",
      managerUserId,
      name: "Pacific Plumbing",
      trade: "Plumbing",
      trades: ["Plumbing"],
      phone: "+1 (206) 555-0188",
      email: "pacific.plumbing@example.com",
      notes: "",
      active: true,
      propertyIds: ["demo-prop-alder", "demo-prop-maple", "demo-prop-fremont"],
    },
  ];

  const workOrders: DemoManagerWorkOrderRow[] = [
    {
      id: "demo-wo-alder-faucet",
      reference: "WO-1042",
      propertyName: "Alder House",
      propertyId: "demo-prop-alder",
      unit: "Alder House",
      title: "Kitchen faucet drip",
      priority: "Normal",
      status: "Scheduled",
      bucket: "scheduled",
      description: "Kitchen faucet has been dripping for two days.",
      scheduled: "Thu 10:00 AM – 12:00 PM",
      scheduledAtIso: new Date(Date.now() + 2 * DAY_MS).toISOString(),
      cost: "$140.00",
      residentName,
      residentEmail,
    },
    {
      id: "demo-wo-maple-heat",
      reference: "WO-1043",
      propertyName: "Maple Duplex",
      propertyId: "demo-prop-maple",
      unit: "Maple Duplex · Unit A",
      title: "No hot water",
      priority: "Urgent",
      status: "Open",
      bucket: "open",
      description: "No hot water since this morning.",
      scheduled: "",
      cost: "",
      residentName: "Sample Resident",
      residentEmail: "sample.resident.maple@example.com",
    },
  ];

  const workOrderBids: WorkOrderBid[] = [
    {
      id: "demo-bid-alder-faucet",
      workOrderId: "demo-wo-alder-faucet",
      vendorUserId: "demo-vendor-pacific-plumbing",
      vendorDirectoryId: "demo-vendor-pacific-plumbing",
      vendorName: "Pacific Plumbing",
      vendorEmail: "pacific.plumbing@example.com",
      quoteMode: "upfront",
      consultationVisitAt: null,
      amountCents: 14000,
      materialsCents: 0,
      proposedTime: new Date(Date.now() + 2 * DAY_MS).toISOString(),
      note: "Standard faucet cartridge replacement.",
      status: "accepted",
      createdAt: daysAgo(3).toISOString(),
      updatedAt: daysAgo(2).toISOString(),
    },
    // The Maple Duplex work order stays unbid on purpose (a second bid row
    // for the same vendor in one upsert batch collides downstream in the DB
    // writer — "ON CONFLICT DO UPDATE command cannot affect row a second
    // time" — not worth a second synthetic vendor just to avoid it). An
    // open, un-bid "No hot water" job is its own real state to show.
  ];

  // Three tours this week, across all three properties.
  const tourAttendees = [
    { name: "Jamie P.", email: "jamie.p@example.com", propertyId: "demo-prop-fremont", propertyTitle: "Fremont Studio", inDays: 1 },
    { name: "Sample Prospect Two", email: "sample.prospect.two@example.com", propertyId: "demo-prop-maple", propertyTitle: "Maple Duplex", inDays: 2 },
    { name: "Sample Prospect Three", email: "sample.prospect.three@example.com", propertyId: "demo-prop-alder", propertyTitle: "Alder House", inDays: 4 },
  ];
  const schedule: DemoScheduleSeed = {
    plannedEvents: tourAttendees.map((t, i) => ({
      id: `demo-tour-${i}`,
      title: `Tour · ${t.propertyTitle}`,
      start: new Date(Date.now() + t.inDays * DAY_MS).toISOString(),
      end: new Date(Date.now() + t.inDays * DAY_MS + 30 * 60 * 1000).toISOString(),
      kind: "tour",
      managerUserId,
      propertyId: t.propertyId,
      propertyTitle: t.propertyTitle,
      attendeeName: t.name,
      attendeeEmail: t.email,
      notes: "",
    })),
    partnerInquiries: [],
    availabilityByPropertyId: {},
  };

  // Communication — the SAME names/story the home page's own Communication
  // mock uses (site/story.tsx: Jamie P., Dana Reyes, Pacific Plumbing, Ethan
  // Wright), so the two sections read as one consistent product.
  const now = new Date();
  const managerInbox: PersistedInboxThread[] = [
    {
      id: "demo-thread-jamie",
      folder: "inbox",
      from: "Jamie P.",
      email: "jamie.p@example.com",
      subject: "Tour at Fremont Studio",
      preview: "2 PM please!",
      body: "Hi! Is the room at 142 Ash St still available? Could I see it Saturday afternoon?",
      time: new Date(now.getTime() - 45 * 60 * 1000).toISOString(),
      unread: true,
      rootChannel: "sms",
    },
    {
      id: "demo-thread-dana",
      folder: "inbox",
      from: "Dana Reyes",
      email: "dana.reyes@example.com",
      subject: "Kitchen faucet",
      preview: "Service request #1042 · Pacific Plumbing booked Thu 10–12",
      body: "Hi, the kitchen faucet in Alder House has been dripping for two days. Can someone take a look?",
      time: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      unread: true,
      rootChannel: "email",
    },
    {
      id: "demo-thread-pacific-plumbing",
      folder: "inbox",
      from: "Pacific Plumbing",
      email: "pacific.plumbing@example.com",
      subject: "Job #1042",
      preview: "Running 20 min late — gate code?",
      body: "Running 20 min late for Alder House. Is there a gate code? Is the resident home?",
      time: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(),
      unread: true,
      rootChannel: "sms",
    },
    {
      id: "demo-thread-ethan",
      folder: "inbox",
      from: "Ethan Wright",
      email: "ethan.wright@example.com",
      subject: "Application fee",
      preview: "Do you take card for the application fee?",
      body: "Hi, do you take card for the application fee, or is it bank transfer only?",
      time: new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString(),
      unread: false,
      rootChannel: "email",
    },
  ];

  return {
    ...emptySnapshot(),
    properties,
    applications,
    charges,
    rentProfiles,
    leases,
    vendors,
    workOrders,
    workOrderBids,
    managerInbox,
    schedule,
  };
}

/**
 * Idle explore mode — the static baseline `/demo` seeds when no mirror snapshot
 * is available. Populated with the Seattle Homes portfolio (captain
 * 2026-09-25) so the sandbox never regresses to an empty dashboard even if the
 * DB mirror is off or unseeded in a given environment; the mirror (real rows
 * on the canonical account) still wins whenever it has data of its own.
 */
export function buildDemoIdleSnapshot(): DemoDataSnapshot {
  return seattleHomesSnapshot();
}

/** Cumulative guided-story data — autoplay creates everything through the real wizards. */
export function buildDemoGuidedDataThrough(_through: number): DemoDataSnapshot {
  return buildDemoBlankSnapshot();
}

/** Data for the current guided step — always empty at tour start. */
export function buildDemoGuidedSnapshot(_step: GuidedDemoStep): DemoDataSnapshot {
  return buildDemoBlankSnapshot();
}
