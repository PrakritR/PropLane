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

  // Alder House: leased and occupied by the canonical demo resident.
  const leases: LeasePipelineRow[] = [
    {
      id: "demo-lease-alder",
      residentName,
      residentEmail,
      residentUserId,
      managerUserId,
      propertyId: "demo-prop-alder",
      unit: "Alder House",
      stageLabel: "Fully signed",
      status: "Fully Signed",
      updated: isoDate(daysAgo(60)),
      updatedAtIso: daysAgo(60).toISOString(),
      signedAtIso: daysAgo(60).toISOString(),
      fullySignedAt: daysAgo(60).toISOString(),
      bucket: "signed",
      pdfVersion: 1,
      notes: "",
      signedRentLabel: "$3,200/mo",
      thread: [],
    },
  ];

  const rentProfiles: RecurringRentProfile[] = [
    {
      id: "demo-rentprofile-alder",
      residentEmail,
      residentName,
      residentUserId,
      propertyId: "demo-prop-alder",
      propertyLabel: "Alder House",
      roomLabel: "Whole house",
      managerUserId,
      // Dollars, not cents (RecurringRentProfile.monthlyRent) — 320000 here
      // silently fed the real monthly rent-charge generator and produced two
      // real $320,000.00 charge rows (hc_rent_resident_..._2026-07/-10) on
      // the shared account before this was caught; that mistake is a good
      // reason this constant has its own comment now.
      monthlyRent: 3200,
      dueDay: 1,
      startMonth: isoDate(daysAgo(60)).slice(0, 7),
      active: true,
      updatedAt: daysAgo(60).toISOString(),
    },
  ];

  // One paid charge (this month, on time) and one overdue charge (past due,
  // unpaid) so "Rent collected" and "Needs attention" both have something real.
  const charges: HouseholdCharge[] = [
    {
      id: "demo-charge-alder-paid",
      createdAt: daysAgo(35).toISOString(),
      residentEmail,
      residentName,
      residentUserId,
      propertyId: "demo-prop-alder",
      propertyLabel: "Alder House",
      managerUserId,
      kind: "rent",
      title: "Rent",
      amountLabel: "$3,200.00",
      balanceLabel: "$0.00",
      status: "paid",
      blocksLeaseUntilPaid: false,
      paidAmountCents: 320000,
      paidAt: daysAgo(33).toISOString(),
      paidMethod: "bank",
      dueDay: 1,
      rentMonth: isoDate(daysAgo(35)).slice(0, 7),
    },
    {
      id: "demo-charge-alder-overdue",
      createdAt: daysAgo(6).toISOString(),
      residentEmail,
      residentName,
      residentUserId,
      propertyId: "demo-prop-alder",
      propertyLabel: "Alder House",
      managerUserId,
      kind: "rent",
      title: "Rent",
      amountLabel: "$3,200.00",
      balanceLabel: "$3,200.00",
      status: "pending",
      blocksLeaseUntilPaid: false,
      dueDay: 1,
      dueDateLabel: isoDate(daysAgo(6)),
      rentMonth: isoDate(daysAgo(6)).slice(0, 7),
    },
  ];

  // Maple Duplex: one pending application waiting on a decision.
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
  ];

  // Fremont Studio: one upcoming tour.
  const schedule: DemoScheduleSeed = {
    plannedEvents: [
      {
        id: "demo-tour-fremont",
        title: "Tour · Fremont Studio",
        start: new Date(Date.now() + 3 * DAY_MS).toISOString(),
        end: new Date(Date.now() + 3 * DAY_MS + 30 * 60 * 1000).toISOString(),
        kind: "tour",
        managerUserId,
        propertyId: "demo-prop-fremont",
        propertyTitle: "Fremont Studio",
        attendeeName: "Sample Prospect",
        attendeeEmail: "sample.prospect@example.com",
        notes: "",
      },
    ],
    partnerInquiries: [],
    availabilityByPropertyId: {},
  };

  return {
    ...emptySnapshot(),
    properties,
    applications,
    charges,
    rentProfiles,
    leases,
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
