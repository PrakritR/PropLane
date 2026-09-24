/** Routed detail tabs for manager property inline detail (Appendix C2). */
export const PROPERTY_DETAIL_TABS = [
  "preview",
  "house-details",
  "move-in",
  "application",
  "lease",
  "tours",
  "bookings",
  "requests",
  "promotion",
  "ai-info",
  // The shared trio (PLAN-0920-1058, area 1a) — every record kind's rail ends
  // here; see `src/lib/portals/record-sections.ts`.
  "communication",
  "documents",
  "activity",
] as const;

export type PropertyDetailTabId = (typeof PROPERTY_DETAIL_TABS)[number];

export const PROPERTY_DETAIL_TAB_LABELS: Record<PropertyDetailTabId, string> = {
  preview: "Preview",
  "house-details": "House details",
  "move-in": "Move-in",
  application: "Application",
  lease: "Lease",
  tours: "Tours",
  bookings: "Bookings",
  requests: "Requests",
  promotion: "Promotion",
  "ai-info": "AI info",
  communication: "Communication",
  documents: "Documents",
  activity: "Activity",
};

/** Property detail tabs that appear before application/lease in the manager UI. */
export const PROPERTY_DETAIL_SECTION_TABS = [
  "preview",
  "house-details",
  "move-in",
] as const satisfies readonly PropertyDetailTabId[];

export type PropertyDetailSectionTabId = (typeof PROPERTY_DETAIL_SECTION_TABS)[number];

export const PROPERTY_DETAIL_TOP_TAB_LABELS = {
  preview: "Preview",
  "house-details": "House details",
  "move-in": "Move-in",
  tours: "Tours",
  bookings: "Bookings",
  application: "Application",
  lease: "Lease",
  requests: "Services",
  promotion: "Promotion",
  "ai-info": "AI info",
  communication: "Communication",
  documents: "Documents",
  activity: "Activity",
} as const;

/** In-content scope chips under the Preview top tab (listing gallery vs house vs move-in). */
export const PROPERTY_DETAIL_SCOPE_LABELS: Record<PropertyDetailSectionTabId, string> = {
  preview: "Listing",
  "house-details": "House details",
  "move-in": "Move-in",
};

export type PropertyDetailTopTabId = keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS;

/**
 * What each destination is FOR, in one line.
 *
 * A tab label alone never explained itself — "Apply" and "Promo" say nothing to
 * someone who has not used the product. On a phone the nine tabs are a list
 * rather than a strip (see `PortalPropertySectionList`), and a list has room to
 * say what the row does. This is not decoration: it is the difference between a
 * label and an answer.
 */
export const PROPERTY_DETAIL_TOP_TAB_DESCRIPTIONS: Record<PropertyDetailTopTabId, string> = {
  preview: "How renters see this home",
  "house-details": "Rooms, floors, amenities and rules",
  "move-in": "What a new resident does first",
  tours: "Let renters book a viewing",
  bookings: "Nightly and short stays",
  application: "Screen renters online",
  lease: "Draft, send and e-sign",
  requests: "Repairs and resident requests",
  promotion: "Share and syndicate the listing",
  "ai-info": "What the assistant says about this home",
  communication: "Messages about this home",
  documents: "Files about this home",
  activity: "What changed and when",
};

export const PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS: Partial<
  Record<PropertyDetailTopTabId, string>
> = {
  "house-details": "House",
  "move-in": "Move-in",
  application: "Apply",
  promotion: "Promo",
  "ai-info": "AI",
};

export function propertyDetailTopNavId(tab: PropertyDetailTabId): PropertyDetailTopTabId {
  if (tab === "house-details") return "house-details";
  if (tab === "move-in") return "move-in";
  if (tab === "tours") return "tours";
  if (tab === "bookings") return "bookings";
  if (tab === "application") return "application";
  if (tab === "lease") return "lease";
  if (tab === "requests") return "requests";
  if (tab === "promotion") return "promotion";
  if (tab === "ai-info") return "ai-info";
  if (tab === "communication") return "communication";
  if (tab === "documents") return "documents";
  if (tab === "activity") return "activity";
  if ((PROPERTY_DETAIL_SECTION_TABS as readonly string[]).includes(tab)) return "preview";
  return "preview";
}

/** Routed detail tabs for manager resident profile (Appendix C2). */
export const RESIDENT_DETAIL_TABS = [
  // Overview lands first (round 3): who they are, where they live, what is
  // due and what is waiting — the property page's Preview, for a person.
  "overview",
  "tours",
  "application",
  "background-check",
  "lease",
  "payments",
  "services",
  "inspections",
  "communication",
  "documents",
  "activity",
] as const;

export type ResidentDetailTabId = (typeof RESIDENT_DETAIL_TABS)[number];

export const RESIDENT_DETAIL_TAB_LABELS: Record<ResidentDetailTabId, string> = {
  overview: "Overview",
  "background-check": "Background check",
  application: "Application",
  lease: "Lease",
  tours: "Tours",
  payments: "Payments",
  services: "Services",
  inspections: "Inspections",
  communication: "Communication",
  documents: "Documents",
  activity: "Activity",
};

/** Compact labels for resident detail tabs on phone-width layouts. */
export const RESIDENT_DETAIL_TAB_SHORT_LABELS: Record<ResidentDetailTabId, string> = {
  overview: "Home",
  "background-check": "Screen",
  application: "Apply",
  lease: "Lease",
  tours: "Tours",
  payments: "Pay",
  services: "Svc",
  inspections: "Inspect",
  communication: "Comms",
  documents: "Docs",
  activity: "Activity",
};

export const RESIDENT_DETAIL_TAB_DESCRIPTIONS: Record<ResidentDetailTabId, string> = {
  overview: "Who they are and what is waiting",
  tours: "Viewings for this person",
  application: "Screen this renter",
  "background-check": "Screening results",
  lease: "Draft, send and e-sign",
  payments: "Charges and receipts",
  services: "Repairs and requests",
  inspections: "Move-in and move-out photos",
  communication: "Messages with this person",
  documents: "Files about this person",
  activity: "What changed and when",
};

/** Sidebar subsection ids under Residents when viewing an applicant profile. */
export const RESIDENT_APPLICANT_SIDEBAR_TABS = ["background-check", "application"] as const;
export type ResidentApplicantSidebarTabId = (typeof RESIDENT_APPLICANT_SIDEBAR_TABS)[number];

export const RESIDENT_APPLICANT_SIDEBAR_TAB_LABELS: Record<ResidentApplicantSidebarTabId, string> = {
  "background-check": "Background check",
  application: "Application",
};

export function parseResidentApplicantSidebarTab(raw: string | undefined | null): ResidentApplicantSidebarTabId {
  if (raw === "background-check") return "background-check";
  return "application";
}

export function parsePropertyDetailTab(raw: string | undefined | null): PropertyDetailTabId {
  if (raw === "tour-calendar" || raw === "calendar" || raw === "booking-calendars") return "tours";
  if (raw && (PROPERTY_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as PropertyDetailTabId;
  }
  return "preview";
}

/**
 * Legacy sub-paths under a property's Calendar tab. Tours moved to the `tours` detail tab;
 * calendar is bookings-only. Old `/calendar/tours` links redirect in render-portal-section.
 */
export const PROPERTY_CALENDAR_SUB_TABS = ["bookings"] as const;
export type PropertyCalendarSubTabId = (typeof PROPERTY_CALENDAR_SUB_TABS)[number];

export const PROPERTY_CALENDAR_SUB_TAB_LABELS: Record<PropertyCalendarSubTabId, string> = {
  bookings: "Bookings",
};

export function parsePropertyCalendarSubTab(raw: string | undefined | null): PropertyCalendarSubTabId {
  if (raw === "tours") return "bookings";
  if (raw && (PROPERTY_CALENDAR_SUB_TABS as readonly string[]).includes(raw)) {
    return raw as PropertyCalendarSubTabId;
  }
  return "bookings";
}


export function parseResidentDetailTab(raw: string | undefined | null): ResidentDetailTabId {
  if (raw === "applicant") return "application";
  if (raw && (RESIDENT_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as ResidentDetailTabId;
  }
  return "overview";
}

export function propertyDetailHref(
  basePath: string,
  stage: string,
  propertyKey: string,
  tab: PropertyDetailTabId,
): string {
  return `${basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/${tab}`;
}

/** Add service / Add task → this house’s Services tab (listed vs drafts). */
export function propertyServicesCatalogHref(
  basePath: string,
  propertyId: string,
  saveTarget: { mode: "pending" | "listing" | "requestChange" } | null,
): string | null {
  const id = propertyId.trim();
  if (!id || !saveTarget) return null;
  const stage = saveTarget.mode === "pending" ? "drafts" : "listed";
  return propertyDetailHref(basePath, stage, id, "requests");
}

/**
 * Manager property pipeline stages. `all` is the default: every home on one list,
 * with its state on the row — the three narrower stages are filters over it.
 */
export const PROPERTY_STAGES = ["all", "listed", "drafts", "unlisted"] as const;
export type PropertyStageId = (typeof PROPERTY_STAGES)[number];

export function parsePropertyStage(raw: string | undefined | null): PropertyStageId {
  if (raw && (PROPERTY_STAGES as readonly string[]).includes(raw)) {
    return raw as PropertyStageId;
  }
  return "all";
}

export function propertyListHref(basePath: string, stage: string): string {
  return `${basePath}/properties/${stage}`;
}

/**
 * Manager resident directory stages, in funnel order: people who might live
 * here, people who do, people who did. `potential` covers everything before an
 * executed lease — an unfinished application, one awaiting review, and an
 * approved one nobody has signed yet (`residentDirectoryStage`).
 */
export const RESIDENT_DIRECTORY_TABS = ["potential", "current", "past"] as const;
export type ResidentsTabId = (typeof RESIDENT_DIRECTORY_TABS)[number];

export const RESIDENT_DIRECTORY_TAB_LABELS: Record<ResidentsTabId, string> = {
  potential: "Potential",
  current: "Current",
  past: "Past",
};

export function parseResidentsTab(raw: string | undefined | null): ResidentsTabId {
  if (raw === "past" || raw === "previous") return "past";
  if (raw === "potential" || raw === "prospects") return "potential";
  return "current";
}

/**
 * Which profile tabs a person gets, by directory stage.
 *
 * A prospect has no tenancy, so Services — the add-on and maintenance queue a
 * tenant raises — has nothing to show and nothing to add. Tours stay on every
 * stage (PRP-394): a Current/Past tenant's tour history is still reachable from
 * their profile, scoped to the viewing manager's portfolio in the panel.
 */
export const RESIDENT_DETAIL_TABS_BY_STAGE: Record<ResidentsTabId, readonly ResidentDetailTabId[]> = {
  potential: RESIDENT_DETAIL_TABS.filter((tab) => tab !== "services"),
  current: RESIDENT_DETAIL_TABS,
  past: RESIDENT_DETAIL_TABS,
};

export function residentDetailTabsForStage(stage: ResidentsTabId): readonly ResidentDetailTabId[] {
  return RESIDENT_DETAIL_TABS_BY_STAGE[stage];
}

export function residentListHref(basePath: string, tab: ResidentsTabId): string {
  return `${basePath}/residents/${tab}`;
}

export function residentDetailHref(
  basePath: string,
  residentsTab: string,
  residentId: string,
  tab: ResidentDetailTabId,
): string {
  return `${basePath}/residents/${residentsTab}/${encodeURIComponent(residentId)}/${tab}`;
}

/** One list item under a manager resident profile tab (payments, tours, services). */
export function managerResidentItemDetailHref(
  basePath: string,
  residentsTab: string,
  residentId: string,
  tab: Extract<ResidentDetailTabId, "payments" | "tours" | "services">,
  itemId: string,
): string {
  return `${basePath}/residents/${residentsTab}/${encodeURIComponent(residentId)}/${tab}/${encodeURIComponent(itemId)}`;
}

export function managerResidentTourListHref(
  basePath: string,
  residentsTab: string,
  residentId: string,
  bucket: ManagerTourBucketId = "pending",
): string {
  return `${basePath}/residents/${residentsTab}/${encodeURIComponent(residentId)}/tours/${bucket}`;
}

export function managerResidentTourDetailHref(
  basePath: string,
  residentsTab: string,
  residentId: string,
  bucket: ManagerTourBucketId,
  tourId: string,
): string {
  return `${managerResidentTourListHref(basePath, residentsTab, residentId, bucket)}/${encodeURIComponent(tourId)}`;
}

export function residentPaymentDetailHref(
  basePath: string,
  residentsTab: string,
  residentId: string,
  paymentId: string,
): string {
  return managerResidentItemDetailHref(basePath, residentsTab, residentId, "payments", paymentId);
}


/**
 * Portfolio calendar sections (PLAN-0914-1710): one week grid, four views of it.
 * `all` is every PropLane event with Google busy time as the backdrop; the other
 * three show one kind alone. `/portal/calendar` renders `all`.
 */
export const CALENDAR_VIEW_TABS = ["all", "tours", "services", "tasks"] as const;
export type CalendarViewTabId = (typeof CALENDAR_VIEW_TABS)[number];

export const CALENDAR_VIEW_TAB_LABELS: Record<CalendarViewTabId, string> = {
  all: "All",
  tours: "Tours",
  services: "Services",
  tasks: "Tasks",
};

export const DEFAULT_CALENDAR_VIEW: CalendarViewTabId = "all";

/** Combined tours + service orders live under Operations → Tours, not Calendar. */
export const PORTFOLIO_TOURS_HREF = "/portal/tours";

/** Retired view names (`schedule`, `availability`) and anything unknown land on `all`. */
export function parseCalendarViewTab(raw: string | undefined | null): CalendarViewTabId {
  if (raw && (CALENDAR_VIEW_TABS as readonly string[]).includes(raw)) {
    return raw as CalendarViewTabId;
  }
  return DEFAULT_CALENDAR_VIEW;
}

export function calendarViewHref(basePath: string, tab: CalendarViewTabId | "bookings"): string {
  if (tab === "bookings") return managerBookingListHref(basePath, DEFAULT_MANAGER_BOOKING_BUCKET);
  return tab === DEFAULT_CALENDAR_VIEW ? `${basePath}/calendar` : `${basePath}/calendar/${tab}`;
}

/** Vendor calendar views. List is the accessible record view of the same visits. */
export const VENDOR_CALENDAR_VIEW_TABS = ["list", "day", "week", "month"] as const;
export type VendorCalendarViewTabId = (typeof VENDOR_CALENDAR_VIEW_TABS)[number];
export const DEFAULT_VENDOR_CALENDAR_VIEW: VendorCalendarViewTabId = "week";

export function parseVendorCalendarViewTab(raw: string | undefined | null): VendorCalendarViewTabId {
  if (raw && (VENDOR_CALENDAR_VIEW_TABS as readonly string[]).includes(raw)) {
    return raw as VendorCalendarViewTabId;
  }
  return DEFAULT_VENDOR_CALENDAR_VIEW;
}

export function vendorCalendarViewHref(basePath: string, tab: VendorCalendarViewTabId): string {
  return tab === DEFAULT_VENDOR_CALENDAR_VIEW ? `${basePath}/calendar` : `${basePath}/calendar/${tab}`;
}

export function bookingsHref(basePath: string): string {
  return managerBookingListHref(basePath, DEFAULT_MANAGER_BOOKING_BUCKET);
}

/**
 * Manager portfolio booking buckets. The calendar is first and the default:
 * "is this room free on the 14th" is the question the screen answers, and a
 * list cannot answer it at a glance.
 */
export const MANAGER_BOOKING_BUCKETS = ["calendar", "upcoming", "inhouse", "past"] as const;
export type ManagerBookingBucketId = (typeof MANAGER_BOOKING_BUCKETS)[number];
export const DEFAULT_MANAGER_BOOKING_BUCKET: ManagerBookingBucketId = "calendar";

export const MANAGER_BOOKING_BUCKET_LABELS: Record<ManagerBookingBucketId, string> = {
  calendar: "Calendar",
  upcoming: "Upcoming",
  inhouse: "In-house",
  past: "Past",
};

export function parseManagerBookingBucket(
  raw: string | undefined | null,
): ManagerBookingBucketId {
  if (raw && (MANAGER_BOOKING_BUCKETS as readonly string[]).includes(raw)) {
    return raw as ManagerBookingBucketId;
  }
  return DEFAULT_MANAGER_BOOKING_BUCKET;
}

export function managerBookingListHref(
  basePath: string,
  bucket: ManagerBookingBucketId = DEFAULT_MANAGER_BOOKING_BUCKET,
): string {
  return `${basePath}/bookings/${bucket}`;
}

/**
 * A booking record's own routed tabs (PLAN-0920-1058, area 1e). Own sections
 * come from `src/lib/portals/record-sections.ts`; this is the URL contract
 * they and `render-portal-section.tsx` both read.
 */
export const BOOKING_DETAIL_TABS = [
  "overview",
  "guest",
  "charges",
  "communication",
  "documents",
  "activity",
] as const;
export type BookingDetailTabId = (typeof BOOKING_DETAIL_TABS)[number];
export const DEFAULT_BOOKING_DETAIL_TAB: BookingDetailTabId = "overview";

export function parseBookingDetailTab(raw: string | undefined | null): BookingDetailTabId {
  if (raw && (BOOKING_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as BookingDetailTabId;
  }
  return DEFAULT_BOOKING_DETAIL_TAB;
}

/**
 * A booking has no stored id of its own — `bookingEntryKey` (source, property,
 * room, dates, summary) is what already identifies one row for selection, so
 * the record route reuses it verbatim as the opaque id. Never collides with a
 * bucket keyword (`calendar`/`upcoming`/`inhouse`/`past`) or a day-page date.
 */
export function bookingRecordHref(
  basePath: string,
  bookingId: string,
  tab: BookingDetailTabId = DEFAULT_BOOKING_DETAIL_TAB,
): string {
  return `${basePath}/bookings/${encodeURIComponent(bookingId)}/${tab}`;
}

/** `YYYY-MM-DD` — the day popup deep link over `/bookings/calendar`. */
const BOOKING_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isBookingDayKeySegment(segment: string): boolean {
  return BOOKING_DAY_KEY_PATTERN.test(segment);
}

export function managerBookingDayHref(basePath: string, dayKey: string): string {
  return `${basePath}/bookings/${dayKey}`;
}

export function portfolioToursHref(basePath: string): string {
  return `${basePath}/tours/pending`;
}

/** Manager portfolio tour list buckets (table view). */
export const MANAGER_TOUR_BUCKETS = ["pending", "upcoming", "past"] as const;
export type ManagerTourBucketId = (typeof MANAGER_TOUR_BUCKETS)[number];

export const MANAGER_TOUR_BUCKET_LABELS: Record<ManagerTourBucketId, string> = {
  pending: "Pending",
  upcoming: "Upcoming",
  past: "Past",
};

export function parseManagerTourBucket(raw: string | undefined | null): ManagerTourBucketId {
  if (raw && (MANAGER_TOUR_BUCKETS as readonly string[]).includes(raw)) {
    return raw as ManagerTourBucketId;
  }
  return "pending";
}

export function managerTourListHref(basePath: string, bucket: ManagerTourBucketId = "pending"): string {
  return `${basePath}/tours/${bucket}`;
}

/**
 * Tour record rail tabs (PLAN-0921-1029, area 2): trimmed to Overview ·
 * Communication — "prospect", "slot" and "follow-up" fold into Overview's own
 * fact cards (Prospect, Listing) instead of staying separate tabs.
 */
export const TOUR_DETAIL_TABS = ["overview", "communication"] as const;
export type TourDetailTabId = (typeof TOUR_DETAIL_TABS)[number];

const TOUR_DETAIL_TAB_ALIASES: Record<string, TourDetailTabId> = {
  prospect: "overview",
  slot: "overview",
  "follow-up": "overview",
};

export function parseTourDetailTab(raw: string | undefined | null): TourDetailTabId {
  if (raw && (TOUR_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as TourDetailTabId;
  }
  return (raw && TOUR_DETAIL_TAB_ALIASES[raw]) || "overview";
}

export function managerTourDetailHref(
  basePath: string,
  bucket: ManagerTourBucketId,
  tourId: string,
  tab: TourDetailTabId = "overview",
): string {
  const base = `${basePath}/tours/${bucket}/${encodeURIComponent(tourId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

export function propertyTourListHref(
  basePath: string,
  stage: PropertyStageId,
  propertyKey: string,
  bucket: ManagerTourBucketId = "pending",
): string {
  return `${propertyDetailHref(basePath, stage, propertyKey, "tours")}/${bucket}`;
}

export function propertyTourDetailHref(
  basePath: string,
  stage: PropertyStageId,
  propertyKey: string,
  bucket: ManagerTourBucketId,
  tourId: string,
): string {
  return `${propertyTourListHref(basePath, stage, propertyKey, bucket)}/${encodeURIComponent(tourId)}`;
}

export const MANAGER_TASK_LIST_TABS = ["in-progress", "overdue", "completed"] as const;
export type ManagerTaskListTabId = (typeof MANAGER_TASK_LIST_TABS)[number];

/** Vendor task list keeps two tabs — overdue is manager-only. */
export const VENDOR_TASK_LIST_TABS = ["in-progress", "completed"] as const;
export type VendorTaskListTabId = (typeof VENDOR_TASK_LIST_TABS)[number];

export const VENDOR_TASK_LIST_TAB_LABELS: Record<VendorTaskListTabId, string> = {
  "in-progress": "In progress",
  completed: "Completed",
};

export const MANAGER_TASK_LIST_TAB_LABELS: Record<ManagerTaskListTabId, string> = {
  // Open / Overdue / Done — the slugs stay, so every saved link still lands.
  "in-progress": "Open",
  overdue: "Overdue",
  completed: "Done",
};

export function parseManagerTaskListTab(raw: string | undefined | null): ManagerTaskListTabId {
  if (raw === "completed") return "completed";
  if (raw === "overdue" || raw === "late") return "overdue";
  return "in-progress";
}

export function parseVendorTaskListTab(raw: string | undefined | null): VendorTaskListTabId {
  if (raw === "completed") return "completed";
  return "in-progress";
}

export const VENDOR_WORK_ORDER_LIST_TABS = ["pending", "upcoming", "past"] as const;
export type VendorWorkOrderListTabId = (typeof VENDOR_WORK_ORDER_LIST_TABS)[number];
export const DEFAULT_VENDOR_WORK_ORDER_TAB: VendorWorkOrderListTabId = "pending";

export const VENDOR_WORK_ORDER_LIST_TAB_LABELS: Record<VendorWorkOrderListTabId, string> = {
  pending: "Pending",
  upcoming: "Upcoming",
  past: "Past",
};

export const VENDOR_WORK_ORDER_LEGACY_LIST_TABS: Record<string, VendorWorkOrderListTabId> = {
  quote: "pending",
  tour: "pending",
  scheduled: "upcoming",
  completed: "past",
};

export function parseVendorWorkOrderListTab(raw: string | undefined | null): VendorWorkOrderListTabId {
  if (raw && (VENDOR_WORK_ORDER_LIST_TABS as readonly string[]).includes(raw)) {
    return raw as VendorWorkOrderListTabId;
  }
  if (raw && VENDOR_WORK_ORDER_LEGACY_LIST_TABS[raw]) return VENDOR_WORK_ORDER_LEGACY_LIST_TABS[raw]!;
  return DEFAULT_VENDOR_WORK_ORDER_TAB;
}

export function vendorWorkOrderListHref(
  basePath: string,
  tab: VendorWorkOrderListTabId = DEFAULT_VENDOR_WORK_ORDER_TAB,
): string {
  return `${basePath}/work-orders/${tab}`;
}

/**
 * Vendor job (work order) record rail tabs (PLAN-0921-1029, area 2): trimmed
 * to Overview · Schedule · Invoice · Communication. "scope-photos" folds into
 * Overview's Job fact card.
 */
export const VENDOR_JOB_DETAIL_TABS = [
  "overview",
  "schedule",
  "invoice",
  "communication",
] as const;
export type VendorJobDetailTabId = (typeof VENDOR_JOB_DETAIL_TABS)[number];

const VENDOR_JOB_DETAIL_TAB_ALIASES: Record<string, VendorJobDetailTabId> = {
  "scope-photos": "overview",
  "bid-invoice": "invoice",
  documents: "overview",
};

export function parseVendorJobDetailTab(raw: string | undefined | null): VendorJobDetailTabId {
  if (raw && (VENDOR_JOB_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as VendorJobDetailTabId;
  }
  return (raw && VENDOR_JOB_DETAIL_TAB_ALIASES[raw]) || "overview";
}

export function vendorJobDetailHref(
  basePath: string,
  workOrderId: string,
  tab: VendorJobDetailTabId = "overview",
): string {
  const base = `${basePath}/work-orders/${encodeURIComponent(workOrderId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/** Vendor invoice record rail tabs (PLAN-0920-1058, area 1c). */
export const VENDOR_INVOICE_DETAIL_TABS = ["overview", "lines", "payout", "communication", "documents"] as const;
export type VendorInvoiceDetailTabId = (typeof VENDOR_INVOICE_DETAIL_TABS)[number];

export function parseVendorInvoiceDetailTab(raw: string | undefined | null): VendorInvoiceDetailTabId {
  if (raw && (VENDOR_INVOICE_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as VendorInvoiceDetailTabId;
  }
  return "overview";
}

export function vendorInvoiceDetailHref(
  basePath: string,
  invoiceId: string,
  tab: VendorInvoiceDetailTabId = "overview",
): string {
  const base = `${basePath}/financials/invoices/${encodeURIComponent(invoiceId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/** Vendor payout record rail tabs (PLAN-0920-1058, area 1c). */
export const VENDOR_PAYOUT_DETAIL_TABS = ["overview", "included-invoices", "communication"] as const;
export type VendorPayoutDetailTabId = (typeof VENDOR_PAYOUT_DETAIL_TABS)[number];

export function parseVendorPayoutDetailTab(raw: string | undefined | null): VendorPayoutDetailTabId {
  if (raw && (VENDOR_PAYOUT_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as VendorPayoutDetailTabId;
  }
  return "overview";
}

export function vendorPayoutDetailHref(
  basePath: string,
  payoutId: string,
  tab: VendorPayoutDetailTabId = "overview",
): string {
  const base = `${basePath}/financials/payouts/${encodeURIComponent(payoutId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

export function managerTaskListHref(
  basePath: string,
  tab: ManagerTaskListTabId = "in-progress",
): string {
  if (tab === "in-progress") return `${basePath}/tasks`;
  return `${basePath}/tasks/${tab}`;
}

/** Legacy `/task-list/...` bookmarks and emailed links → `/tasks`. */
export function legacyTaskListSectionRedirectPath(
  basePath: string,
  tabParts?: string[],
): string {
  const tab = tabParts?.[0];
  if (!tab || tab === "in-progress") return `${basePath}/tasks`;
  if (tab === "late") return `${basePath}/tasks/overdue`;
  const tail = tabParts!.length > 1 ? `/${tabParts!.slice(1).join("/")}` : "";
  return `${basePath}/tasks/${tab}${tail}`;
}

export const TOURS_HUB_TABS = ["tours", "services"] as const;
export type ToursHubTabId = (typeof TOURS_HUB_TABS)[number];

export const TOURS_HUB_TAB_LABELS: Record<ToursHubTabId, string> = {
  tours: "Tours",
  services: "Service orders",
};

export function parseToursHubTab(raw: string | undefined | null): ToursHubTabId {
  if (raw === "services" || raw === "service-orders") return "services";
  return "tours";
}

export function toursHubHref(basePath: string, tab: ToursHubTabId): string {
  return tab === "tours" ? portfolioToursHref(basePath) : `${portfolioToursHref(basePath)}/services`;
}

/** Routed team link filters (manager relationships). */
export const TEAM_LINK_TABS = ["pending", "linked"] as const;
export type TeamLinkTabId = (typeof TEAM_LINK_TABS)[number];

export function parseTeamLinkTab(raw: string | undefined | null): TeamLinkTabId {
  if (raw && (TEAM_LINK_TABS as readonly string[]).includes(raw)) {
    return raw as TeamLinkTabId;
  }
  return "pending";
}

/** Settings → Workspaces — the only manager team surface (PLAN-0923-1934). */
export function teamLinkHref(basePath: string, _tab?: TeamLinkTabId): string {
  return `${basePath}/profile?tab=workspaces`;
}

/** Member deep-links collapse to the Workspaces list (no standalone Teams detail). */
export function teamMemberDetailHref(basePath: string, _linkId: string): string {
  return teamLinkHref(basePath);
}

/** Manager applications list buckets (Appendix D5). */
export const APPLICATION_BUCKETS = ["incomplete", "pending", "approved", "rejected"] as const;
export type ApplicationBucketId = (typeof APPLICATION_BUCKETS)[number];

/** Application list tabs shown in the Applications hub. */
export const APPLICATION_LIST_TABS = [...APPLICATION_BUCKETS] as const;
export type ApplicationListTabId = (typeof APPLICATION_LIST_TABS)[number];

export function parseApplicationBucket(raw: string | undefined | null): ApplicationBucketId {
  if (raw && (APPLICATION_BUCKETS as readonly string[]).includes(raw)) {
    return raw as ApplicationBucketId;
  }
  return "pending";
}

export function parseApplicationListTab(raw: string | undefined | null): ApplicationListTabId {
  if (raw === "screenings") return "approved";
  if (raw && (APPLICATION_LIST_TABS as readonly string[]).includes(raw)) {
    return raw as ApplicationListTabId;
  }
  return "pending";
}

export function applicationListHref(basePath: string, tab: ApplicationListTabId): string {
  return `${basePath}/applications/${tab}`;
}

/**
 * An application record's own routed tabs (PLAN-0920-1058, area 1c) — the
 * `application` kind's OWN sections in `src/lib/portals/record-sections.ts`
 * plus the shared trio. Screening now nests here instead of a separate
 * top-level list; `"background-check"` still parses (old links, sent
 * messages, bookmarks) and resolves to `"screening"`.
 */
/**
 * PLAN-0921-1029, area 2: trimmed to Overview · Application form · Screening ·
 * Communication. "applicants" and "decision" fold into Application form /
 * Overview's own fact cards rather than staying separate tabs.
 */
export const APPLICATION_DETAIL_TABS = [
  "overview",
  "application-form",
  "screening",
  "communication",
] as const;
export type ApplicationDetailTabId = (typeof APPLICATION_DETAIL_TABS)[number];
export const DEFAULT_APPLICATION_DETAIL_TAB: ApplicationDetailTabId = "overview";

export const APPLICATION_DETAIL_TAB_LABELS: Record<ApplicationDetailTabId, string> = {
  overview: "Overview",
  "application-form": "Application form",
  screening: "Screening",
  communication: "Communication",
};

const APPLICATION_DETAIL_TAB_ALIASES: Record<string, ApplicationDetailTabId> = {
  applicants: "application-form",
  decision: "overview",
  documents: "application-form",
};

export function parseApplicationDetailTab(raw: string | undefined | null): ApplicationDetailTabId {
  if (raw === "application") return DEFAULT_APPLICATION_DETAIL_TAB;
  if (raw === "background-check") return "screening";
  if (raw && (APPLICATION_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as ApplicationDetailTabId;
  }
  return (raw && APPLICATION_DETAIL_TAB_ALIASES[raw]) || DEFAULT_APPLICATION_DETAIL_TAB;
}

export function applicationDetailHref(
  basePath: string,
  bucket: ApplicationBucketId,
  applicationId: string,
  detailTab: ApplicationDetailTabId = DEFAULT_APPLICATION_DETAIL_TAB,
): string {
  const base = `${basePath}/applications/${bucket}/${encodeURIComponent(applicationId)}`;
  return detailTab === DEFAULT_APPLICATION_DETAIL_TAB ? base : `${base}/${detailTab}`;
}

/** The application's own nested Screening tab — replaces the old standalone background-check record route. */
export function applicationScreeningDetailHref(
  basePath: string,
  bucket: ApplicationBucketId,
  applicationId: string,
): string {
  return applicationDetailHref(basePath, bucket, applicationId, "screening");
}

/** Manager background-check list buckets (screening workflow). */
export const BACKGROUND_CHECK_LIST_TABS = ["pending_review", "passed", "flagged"] as const;
export type BackgroundCheckListTabId = (typeof BACKGROUND_CHECK_LIST_TABS)[number];

export const BACKGROUND_CHECK_LIST_TAB_LABELS: Record<BackgroundCheckListTabId, string> = {
  pending_review: "Pending",
  passed: "Passed",
  flagged: "Flagged",
};

export function parseBackgroundCheckListTab(raw: string | undefined | null): BackgroundCheckListTabId {
  if (raw && (BACKGROUND_CHECK_LIST_TABS as readonly string[]).includes(raw)) {
    return raw as BackgroundCheckListTabId;
  }
  return "pending_review";
}

export function backgroundCheckListHref(
  basePath: string,
  tab: BackgroundCheckListTabId = "pending_review",
): string {
  return `${basePath}/background-checks/${tab}`;
}

export function backgroundCheckDetailHref(
  basePath: string,
  tab: BackgroundCheckListTabId,
  applicationId: string,
): string {
  return `${basePath}/background-checks/${tab}/${encodeURIComponent(applicationId)}`;
}

/** Resident application list buckets (Pending / Approved / Rejected). */
export const RESIDENT_APPLICATION_BUCKETS = ["pending", "approved", "rejected"] as const;
export type ResidentApplicationBucketId = (typeof RESIDENT_APPLICATION_BUCKETS)[number];

export function parseResidentApplicationBucket(raw: string | undefined | null): ResidentApplicationBucketId {
  if (raw && (RESIDENT_APPLICATION_BUCKETS as readonly string[]).includes(raw)) {
    return raw as ResidentApplicationBucketId;
  }
  return "pending";
}

export function residentApplicationListHref(
  basePath: string,
  bucket: ResidentApplicationBucketId = "pending",
): string {
  return `${basePath}/applications/${bucket}`;
}

/** Resident application record rail tabs (PLAN-0921-1029, area 2, new kind): Overview · Application form · Communication. */
export const RESIDENT_APPLICATION_DETAIL_TABS = ["overview", "application-form", "communication"] as const;
export type ResidentApplicationDetailTabId = (typeof RESIDENT_APPLICATION_DETAIL_TABS)[number];

export function residentApplicationDetailHref(
  basePath: string,
  bucket: ResidentApplicationBucketId,
  applicationId: string,
  tab: ResidentApplicationDetailTabId = "overview",
): string {
  const base = `${basePath}/applications/${bucket}/${encodeURIComponent(applicationId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/** Manager Documents › Leasing › Applications list. */
export function managerDocumentsApplicationsListHref(basePath: string): string {
  return `${basePath}/documents/applications`;
}

/** Manager Documents › Leasing › one application PDF detail. */
export function managerDocumentsApplicationDetailHref(
  basePath: string,
  applicationId: string,
): string {
  return `${basePath}/documents/applications/${encodeURIComponent(applicationId)}`;
}

/** Resident Documents › Application list. */
export function residentDocumentsApplicationListHref(basePath: string): string {
  return `${basePath}/documents/application`;
}

/** Resident Documents › one application PDF detail. */
export function residentDocumentsApplicationDetailHref(
  basePath: string,
  applicationId: string,
): string {
  return `${basePath}/documents/application/${encodeURIComponent(applicationId)}`;
}

/** Resident Documents › Lease list. */
export function residentDocumentsLeaseListHref(basePath: string): string {
  return `${basePath}/documents/lease`;
}

/** Resident Documents › one signed lease detail. */
export function residentDocumentsLeaseDetailHref(basePath: string, leaseId: string): string {
  return `${basePath}/documents/lease/${encodeURIComponent(leaseId)}`;
}

/** Resident lease list buckets (Pending / Signed). */
export const RESIDENT_LEASE_BUCKETS = ["pending", "signed"] as const;
export type ResidentLeaseBucketId = (typeof RESIDENT_LEASE_BUCKETS)[number];

export function parseResidentLeaseBucket(raw: string | undefined | null): ResidentLeaseBucketId {
  if (raw && (RESIDENT_LEASE_BUCKETS as readonly string[]).includes(raw)) {
    return raw as ResidentLeaseBucketId;
  }
  return "pending";
}

/** Resident Lease section list. */
export function residentLeaseListHref(
  basePath: string,
  bucket: ResidentLeaseBucketId = "pending",
): string {
  return `${basePath}/lease/${bucket}`;
}

/**
 * Resident lease record rail tabs (PLAN-0921-1029, area 2): Overview · Lease
 * document · Payments · Communication.
 */
export const RESIDENT_LEASE_DETAIL_TABS = ["overview", "lease-document", "payments", "communication"] as const;
export type ResidentLeaseDetailTabId = (typeof RESIDENT_LEASE_DETAIL_TABS)[number];

export function parseResidentLeaseDetailTab(raw: string | undefined | null): ResidentLeaseDetailTabId {
  if (raw && (RESIDENT_LEASE_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as ResidentLeaseDetailTabId;
  }
  return "overview";
}

/** Resident Lease section detail. */
export function residentLeaseDetailHref(
  basePath: string,
  bucket: ResidentLeaseBucketId,
  leaseDetailId: string,
  tab: ResidentLeaseDetailTabId = "overview",
): string {
  const base = `${basePath}/lease/${bucket}/${encodeURIComponent(leaseDetailId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/** @deprecated Legacy single-segment detail URLs still resolve; prefer bucketed hrefs. */
export function residentLeaseLegacyDetailHref(basePath: string, leaseDetailId: string): string {
  return `${basePath}/lease/${encodeURIComponent(leaseDetailId)}`;
}

/** Resident Documents › Rent receipts list. */
export function residentDocumentsReceiptsListHref(basePath: string): string {
  return `${basePath}/documents/receipts`;
}

/** Resident Documents › one rent receipt detail. */
export function residentDocumentsReceiptDetailHref(basePath: string, receiptId: string): string {
  return `${basePath}/documents/receipts/${encodeURIComponent(receiptId)}`;
}

export const RESIDENT_TOUR_BUCKETS = ["pending", "confirmed", "declined"] as const;
export type ResidentTourBucketId = (typeof RESIDENT_TOUR_BUCKETS)[number];

export function parseResidentTourBucket(raw: string | undefined | null): ResidentTourBucketId {
  if (raw && (RESIDENT_TOUR_BUCKETS as readonly string[]).includes(raw)) {
    return raw as ResidentTourBucketId;
  }
  return "pending";
}

export function residentTourListHref(basePath: string, bucket: ResidentTourBucketId = "pending"): string {
  return `${basePath}/tour/${bucket}`;
}

export function residentTourDetailHref(
  basePath: string,
  bucket: ResidentTourBucketId,
  inquiryId: string,
): string {
  return `${basePath}/tour/${bucket}/${encodeURIComponent(inquiryId)}`;
}

export const RESIDENT_MOVE_IN_TABS = [
  "placement",
  "housemates",
  "info",
  "amenities",
] as const;
export type ResidentMoveInTabId = (typeof RESIDENT_MOVE_IN_TABS)[number];

export const RESIDENT_MOVE_IN_TAB_LABELS: Record<ResidentMoveInTabId, string> = {
  placement: "Your placement",
  housemates: "Housemates",
  info: "Info & rules",
  amenities: "Amenities",
};

/** Compact labels for house-details sub-tabs on phone-width layouts. */
export const RESIDENT_MOVE_IN_TAB_SHORT_LABELS: Record<ResidentMoveInTabId, string> = {
  placement: "Placement",
  housemates: "Mates",
  info: "Rules",
  amenities: "Amenity",
};

/**
 * "Move-in" sat next to "Inspections" and read as the same thing, so the arrival details it
 * held — keys, parking, access codes — now live under Info & rules and the tab is gone.
 * The URL it owned still resolves rather than silently dropping a resident on Placement.
 * "Inspections" became the resident's own section (`/resident/inspections`); the
 * section renderer redirects that old sub-tab URL before this parser sees it.
 */
const RESIDENT_MOVE_IN_TAB_ALIASES: Record<string, ResidentMoveInTabId> = { instructions: "info" };

export function parseResidentMoveInTab(raw: string | undefined | null): ResidentMoveInTabId {
  if (raw && (RESIDENT_MOVE_IN_TABS as readonly string[]).includes(raw)) {
    return raw as ResidentMoveInTabId;
  }
  return (raw && RESIDENT_MOVE_IN_TAB_ALIASES[raw]) || "placement";
}

export function residentMoveInHref(
  basePath: string,
  tab: ResidentMoveInTabId = "placement",
): string {
  return `${basePath}/move-in/${tab}`;
}

/** Manager lease pipeline tabs (Appendix D5). */
export const LEASE_PIPELINE_TABS = ["manager", "resident", "signed", "completed"] as const;
export type LeasePipelineTabId = (typeof LEASE_PIPELINE_TABS)[number];

export function parseLeasePipelineTab(raw: string | undefined | null): LeasePipelineTabId {
  if (raw && (LEASE_PIPELINE_TABS as readonly string[]).includes(raw)) {
    return raw as LeasePipelineTabId;
  }
  return "manager";
}

export function leaseListHref(basePath: string, tab: LeasePipelineTabId): string {
  return `${basePath}/leases/${tab}`;
}

/**
 * Lease record rail tabs (PLAN-0921-1029, area 2): trimmed to the kept-sections
 * table — Overview · Lease document · Payments · Communication. "terms" and
 * "signatures" fold into the Lease document view (its fact bar + signature
 * block); "amendments" folds into that same view's version history. Old
 * links to any of the three still resolve — they just land on Lease document
 * rather than 404 or silently falling back to Overview.
 */
export const LEASE_DETAIL_TABS = [
  "overview",
  "lease-document",
  "payments",
  "communication",
] as const;
export type LeaseDetailTabId = (typeof LEASE_DETAIL_TABS)[number];

const LEASE_DETAIL_TAB_ALIASES: Record<string, LeaseDetailTabId> = {
  terms: "lease-document",
  signatures: "lease-document",
  amendments: "lease-document",
  documents: "lease-document",
};

export function parseLeaseDetailTab(raw: string | undefined | null): LeaseDetailTabId {
  if (raw && (LEASE_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as LeaseDetailTabId;
  }
  return (raw && LEASE_DETAIL_TAB_ALIASES[raw]) || "overview";
}

export function leaseDetailHref(
  basePath: string,
  tab: LeasePipelineTabId,
  leaseId: string,
  detailTab: LeaseDetailTabId = "overview",
): string {
  const base = `${basePath}/leases/${tab}/${encodeURIComponent(leaseId)}`;
  return detailTab === "overview" ? base : `${base}/${detailTab}`;
}

/** Manager payments direction + status bucket (Appendix D5). */
export const PAYMENT_DIRECTIONS = ["incoming", "outgoing"] as const;
export type PaymentDirectionId = (typeof PAYMENT_DIRECTIONS)[number];

export const PAYMENT_BUCKETS = ["pending", "overdue", "paid"] as const;
export type PaymentBucketId = (typeof PAYMENT_BUCKETS)[number];

export function parsePaymentDirection(raw: string | undefined | null): PaymentDirectionId {
  if (raw && (PAYMENT_DIRECTIONS as readonly string[]).includes(raw)) {
    return raw as PaymentDirectionId;
  }
  return "incoming";
}

export function parsePaymentBucket(raw: string | undefined | null): PaymentBucketId {
  if (raw && (PAYMENT_BUCKETS as readonly string[]).includes(raw)) {
    return raw as PaymentBucketId;
  }
  return "pending";
}

export function paymentListHref(
  basePath: string,
  direction: PaymentDirectionId,
  bucket: PaymentBucketId,
): string {
  return `${basePath}/payments/${direction}/${bucket}`;
}

export function paymentDetailHref(
  basePath: string,
  direction: PaymentDirectionId,
  bucket: PaymentBucketId,
  paymentId: string,
): string {
  return `${basePath}/payments/${direction}/${bucket}/${encodeURIComponent(paymentId)}`;
}

/** Resident portal payments status buckets (Pending / Overdue / Paid). */
export function residentChargesListHref(basePath: string, bucket: PaymentBucketId): string {
  return `${basePath}/payments/${bucket}`;
}

/** Resident payment record rail tabs (PLAN-0921-1029, area 2): Overview · Communication. */
export const RESIDENT_PAYMENT_DETAIL_TABS = ["overview", "communication"] as const;
export type ResidentPaymentDetailTabId = (typeof RESIDENT_PAYMENT_DETAIL_TABS)[number];

export function parseResidentPaymentDetailTab(raw: string | undefined | null): ResidentPaymentDetailTabId {
  if (raw && (RESIDENT_PAYMENT_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as ResidentPaymentDetailTabId;
  }
  return "overview";
}

export function residentChargeDetailHref(
  basePath: string,
  bucket: PaymentBucketId,
  chargeId: string,
  tab: ResidentPaymentDetailTabId = "overview",
): string {
  const base = `${basePath}/payments/${bucket}/${encodeURIComponent(chargeId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

/** Manager add-on service request buckets (Appendix D5). */
export const SERVICE_REQUEST_BUCKETS = ["pending", "approved", "denied"] as const;
export type ServiceRequestBucketId = (typeof SERVICE_REQUEST_BUCKETS)[number];

export function parseServiceRequestBucket(raw: string | undefined | null): ServiceRequestBucketId {
  if (raw && (SERVICE_REQUEST_BUCKETS as readonly string[]).includes(raw)) {
    return raw as ServiceRequestBucketId;
  }
  return "pending";
}

export function serviceRequestListHref(basePath: string, bucket: ServiceRequestBucketId): string {
  return `${basePath}/services/requests/${bucket}`;
}

/**
 * A service record's own routed tabs (PLAN-0920-1058, area 1c) — the
 * `service` kind's OWN sections in `src/lib/portals/record-sections.ts`, not
 * the generic vendor/resident/payments set task and inspection share
 * (`ServiceRecordTabId` below). Shared by both add-on requests and work
 * orders since both route through the one Services rail.
 */
/**
 * PLAN-0921-1029, area 2: trimmed to Overview · Vendor & schedule · Photos ·
 * Payments · Communication. "vendor-bids" and "schedule" merge into one
 * "vendor-schedule" section; "invoice" folds into the Payments section
 * (a service's invoice IS its charge).
 */
export const SERVICE_DETAIL_TABS = [
  "overview",
  "vendor-schedule",
  "photos",
  "payments",
  "communication",
] as const;
export type ServiceDetailTabId = (typeof SERVICE_DETAIL_TABS)[number];
export const DEFAULT_SERVICE_DETAIL_TAB: ServiceDetailTabId = "overview";

const SERVICE_DETAIL_TAB_ALIASES: Record<string, ServiceDetailTabId> = {
  "vendor-bids": "vendor-schedule",
  schedule: "vendor-schedule",
  invoice: "payments",
  documents: "photos",
};

export function parseServiceDetailTab(raw: string | undefined | null): ServiceDetailTabId {
  if (raw && (SERVICE_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as ServiceDetailTabId;
  }
  return (raw && SERVICE_DETAIL_TAB_ALIASES[raw]) || DEFAULT_SERVICE_DETAIL_TAB;
}

export function serviceRequestDetailHref(
  basePath: string,
  bucket: ServiceRequestBucketId,
  requestId: string,
  tab: ServiceDetailTabId = DEFAULT_SERVICE_DETAIL_TAB,
): string {
  const path = `${basePath}/services/requests/${bucket}/${encodeURIComponent(requestId)}`;
  return tab === DEFAULT_SERVICE_DETAIL_TAB ? path : `${path}/${tab}`;
}

/** Manager work order buckets (Appendix D5). */
export const WORK_ORDER_BUCKETS = ["open", "scheduled", "completed"] as const;
export type WorkOrderBucketId = (typeof WORK_ORDER_BUCKETS)[number];

export function parseWorkOrderBucket(raw: string | undefined | null): WorkOrderBucketId {
  if (raw && (WORK_ORDER_BUCKETS as readonly string[]).includes(raw)) {
    return raw as WorkOrderBucketId;
  }
  return "open";
}

export function workOrderListHref(basePath: string, bucket: WorkOrderBucketId): string {
  return `${basePath}/services/work-orders/${bucket}`;
}

export function workOrderDetailHref(
  basePath: string,
  bucket: WorkOrderBucketId,
  workOrderId: string,
  tab: ServiceDetailTabId = DEFAULT_SERVICE_DETAIL_TAB,
): string {
  const path = `${basePath}/services/work-orders/${bucket}/${encodeURIComponent(workOrderId)}`;
  return tab === DEFAULT_SERVICE_DETAIL_TAB ? path : `${path}/${tab}`;
}

/**
 * Routed tabs shared by task and inspection records (PLAN-0921-1029, area 2):
 * trimmed to Overview · Rooms · Payments · Communication. "rooms" is new
 * (inspection's room checklist, formerly the whole Overview tab); "vendor",
 * "resident", "documents" and "activity" fold into Overview's own fact cards
 * instead of staying separate tabs — a task has no rooms, so its own
 * `ownGroups` simply never lists that id.
 */
export const SERVICE_RECORD_TABS = ["overview", "rooms", "payments", "communication"] as const;
export type ServiceRecordTabId = (typeof SERVICE_RECORD_TABS)[number];

const SERVICE_RECORD_TAB_ALIASES: Record<string, ServiceRecordTabId> = {
  vendor: "overview",
  resident: "overview",
  documents: "overview",
  activity: "overview",
};

export const SERVICE_RECORD_TAB_LABELS: Record<ServiceRecordTabId, string> = {
  overview: "Overview",
  rooms: "Rooms",
  communication: "Communication",
  payments: "Payments",
};

export const SERVICE_RECORD_TAB_DESCRIPTIONS: Record<ServiceRecordTabId, string> = {
  overview: "Status, assignment, next visit",
  rooms: "Room-by-room checklist",
  communication: "Thread for this service",
  payments: "Outgoing and charges",
};

export const SERVICE_RECORD_RAIL_GROUPS: Array<{ label: string; ids: ServiceRecordTabId[] }> = [
  { label: "Service", ids: ["overview", "communication"] },
  { label: "Money", ids: ["payments"] },
];

export const TASK_RECORD_TAB_DESCRIPTIONS: Record<ServiceRecordTabId, string> = {
  overview: "Status, assignment, due",
  rooms: "Not used by tasks",
  communication: "Thread for this task",
  payments: "None yet",
};

export const TASK_RECORD_RAIL_GROUPS: Array<{ label: string; ids: ServiceRecordTabId[] }> = [
  { label: "Task", ids: ["overview", "communication"] },
];

export const INSPECTION_RECORD_TAB_DESCRIPTIONS: Record<ServiceRecordTabId, string> = {
  overview: "Kind, status, date",
  rooms: "Room-by-room checklist",
  communication: "Thread for this report",
  payments: "None",
};

export const INSPECTION_RECORD_RAIL_GROUPS: Array<{ label: string; ids: ServiceRecordTabId[] }> = [
  { label: "Inspection", ids: ["overview", "rooms"] },
  { label: "Money", ids: ["payments"] },
  { label: "", ids: ["communication"] },
];

export const PAYMENT_RECORD_TABS = ["overview", "communication", "service", "vendor", "resident", "documents", "activity"] as const;
export type PaymentRecordTabId = (typeof PAYMENT_RECORD_TABS)[number];

export const PAYMENT_RECORD_TAB_LABELS: Record<PaymentRecordTabId, string> = {
  overview: "Overview",
  communication: "Communication",
  service: "Service",
  vendor: "Vendor",
  resident: "Resident",
  documents: "Documents",
  activity: "Activity",
};

export const PAYMENT_RECORD_TAB_DESCRIPTIONS: Record<PaymentRecordTabId, string> = {
  overview: "Amount, direction, status",
  communication: "Thread for this charge",
  service: "Linked service",
  vendor: "Payee",
  resident: "Who this charge is for",
  documents: "Files about this charge",
  activity: "What changed and when",
};

export const PAYMENT_RECORD_RAIL_GROUPS: Array<{ label: string; ids: PaymentRecordTabId[] }> = [
  { label: "Payment", ids: ["overview", "communication"] },
  { label: "Linked", ids: ["service", "vendor", "resident"] },
];

export function parseServiceRecordTab(raw: string | undefined | null): ServiceRecordTabId {
  if (raw && (SERVICE_RECORD_TABS as readonly string[]).includes(raw)) {
    return raw as ServiceRecordTabId;
  }
  return (raw && SERVICE_RECORD_TAB_ALIASES[raw]) || "overview";
}

export function parsePaymentRecordTab(raw: string | undefined | null): PaymentRecordTabId {
  if (raw && (PAYMENT_RECORD_TABS as readonly string[]).includes(raw)) {
    return raw as PaymentRecordTabId;
  }
  return "overview";
}

export function managerTaskDetailHref(
  basePath: string,
  listTab: ManagerTaskListTabId,
  taskId: string,
  tab: ServiceRecordTabId = "overview",
): string {
  const path = `${basePath}/tasks/${listTab}/${encodeURIComponent(taskId)}`;
  return tab === "overview" ? path : `${path}/${tab}`;
}

export function inspectionDetailHref(
  basePath: string,
  kind: "move-in" | "move-out",
  reportId: string,
  tab: ServiceRecordTabId = "overview",
): string {
  const path = `${basePath}/inspections/${kind}/${encodeURIComponent(reportId)}`;
  return tab === "overview" ? path : `${path}/${tab}`;
}

export function paymentRecordDetailHref(
  basePath: string,
  direction: PaymentDirectionId,
  bucket: PaymentBucketId,
  paymentId: string,
  tab: PaymentRecordTabId = "overview",
): string {
  const path = paymentDetailHref(basePath, direction, bucket, paymentId);
  return tab === "overview" ? path : `${path}/${tab}`;
}

/** Manager document record rail tabs (PLAN-0920-1058, area 1c): the record's own sections plus the shared trio. */
export const DOCUMENT_DETAIL_TABS = ["preview", "details", "communication", "activity"] as const;
export type DocumentDetailTabId = (typeof DOCUMENT_DETAIL_TABS)[number];

export function parseDocumentDetailTab(raw: string | undefined | null): DocumentDetailTabId {
  if (raw && (DOCUMENT_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as DocumentDetailTabId;
  }
  return "preview";
}

export function documentRecordHref(
  basePath: string,
  documentId: string,
  tab: DocumentDetailTabId = "preview",
): string {
  const base = `${basePath}/documents/${encodeURIComponent(documentId)}`;
  return tab === "preview" ? base : `${base}/${tab}`;
}

/** Resident service record rail tabs (PLAN-0920-1058, area 1c). */
export const RESIDENT_SERVICE_DETAIL_TABS = ["overview", "updates", "photos", "communication"] as const;
export type ResidentServiceDetailTabId = (typeof RESIDENT_SERVICE_DETAIL_TABS)[number];

export function parseResidentServiceDetailTab(raw: string | undefined | null): ResidentServiceDetailTabId {
  if (raw && (RESIDENT_SERVICE_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as ResidentServiceDetailTabId;
  }
  return "overview";
}

export function residentServiceDetailHref(
  basePath: string,
  serviceId: string,
  tab: ResidentServiceDetailTabId = "overview",
): string {
  const base = `${basePath}/services/${encodeURIComponent(serviceId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}

// Vendors is its own section. These builders point at it directly rather than leaning on the
// compatibility redirects from /teams/vendors and /services/vendors — a link that redirects on
// every click costs a round trip and briefly shows the wrong section as active.
export function vendorListHref(basePath: string, tab: VendorDirectoryTab = "yours"): string {
  return tab === "catalog" ? `${basePath}/vendors?tab=catalog` : `${basePath}/vendors`;
}

export type VendorDirectoryTab = "yours" | "catalog";

export function parseVendorDirectoryTab(raw: string | null | undefined): VendorDirectoryTab {
  return raw === "catalog" ? "catalog" : "yours";
}

export function vendorCatalogDetailHref(
  basePath: string,
  catalogId: string,
  detailTab: VendorDetailTabId = "overview",
): string {
  const params = new URLSearchParams({ tab: "catalog", catalog: catalogId });
  if (detailTab !== "overview") params.set("detailTab", detailTab);
  return `${basePath}/vendors?${params.toString()}`;
}

/** Routed detail tabs for a manager vendor — same chrome as a resident. */
/**
 * "services" and "invoices" (PLAN-0921-1029, area 2) are the manager's OWN
 * vendor kind's trimmed tabs; "profile", "jobs", "pricing", "reviews" and
 * "check-ins" stay valid for the vendor CATALOG kind, which shares this same
 * type — purely additive, so the catalog's own rail is untouched.
 */
export const VENDOR_DETAIL_TABS = ["overview", "profile", "jobs", "pricing", "reviews", "check-ins", "services", "invoices", "communication", "documents", "activity"] as const;
export type VendorDetailTabId = (typeof VENDOR_DETAIL_TABS)[number];

export const VENDOR_DETAIL_TAB_LABELS: Record<VendorDetailTabId, string> = {
  overview: "Overview",
  profile: "Profile",
  jobs: "Jobs",
  pricing: "Pricing",
  reviews: "Reviews",
  "check-ins": "Check-ins",
  services: "Services",
  invoices: "Invoices",
  communication: "Communication",
  documents: "Documents",
  activity: "Activity",
};

export const VENDOR_DETAIL_TAB_DESCRIPTIONS: Record<VendorDetailTabId, string> = {
  overview: "Status, houses, and what needs you",
  profile: "Name, trade, phone, email",
  jobs: "Work assigned to this vendor",
  pricing: "Rates for this vendor",
  reviews: "Ratings from your completed services",
  "check-ins": "Scheduled questions",
  services: "Work assigned to this vendor",
  invoices: "Charges from this vendor",
  communication: "Messages with this vendor",
  documents: "Files about this vendor",
  activity: "What changed and when",
};

export const VENDOR_RAIL_GROUPS: Array<{ label: string; ids: VendorDetailTabId[] }> = [
  { label: "Vendor", ids: ["overview", "profile"] },
  { label: "Work", ids: ["jobs", "pricing", "reviews", "check-ins"] },
  { label: "Contact", ids: ["communication", "documents", "activity"] },
];

export function parseVendorDetailTab(raw: string | undefined | null): VendorDetailTabId {
  if (raw === "messages") return "communication";
  if (raw === "checkins") return "check-ins";
  if (raw === "profile") return "overview";
  if (raw && (VENDOR_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as VendorDetailTabId;
  }
  return "overview";
}

export function vendorDetailHref(basePath: string, vendorId: string, tab: VendorDetailTabId = "overview"): string {
  return `${basePath}/vendors/${encodeURIComponent(vendorId)}/${tab}`;
}

/** Workspace Promotion sections — live in `?kind=`, never a path (collides with [assetId]). */
export const PROMOTION_KIND_SECTIONS = ["all", "text", "image"] as const;
export type PromotionKindSectionId = (typeof PROMOTION_KIND_SECTIONS)[number];

/** Legacy mistaken top-level segments `/portal/text` and `/portal/image`. */
export const PROMOTION_CONTENT_FILTERS = ["text", "image"] as const;
export type PromotionContentFilterId = (typeof PROMOTION_CONTENT_FILTERS)[number];

export function parsePromotionKindSection(
  value: string | null | undefined,
): PromotionKindSectionId {
  if (value === "text" || value === "image") return value;
  return "all";
}

export function promotionListHref(
  basePath: string,
  kind: PromotionKindSectionId | PromotionContentFilterId = "all",
): string {
  const section = parsePromotionKindSection(kind);
  if (section === "all") return `${basePath}/promotion`;
  return `${basePath}/promotion?kind=${section}`;
}

export function promotionDetailHref(basePath: string, assetId: string): string {
  return `${basePath}/promotion/${encodeURIComponent(assetId)}`;
}

/** Map mistaken top-level portal segments to their routed section paths. */
export function legacyManagerPortalSectionPath(section: string): string | null {
  if ((APPLICATION_BUCKETS as readonly string[]).includes(section)) {
    return `applications/${section}`;
  }
  if ((PROPERTY_STAGES as readonly string[]).includes(section)) {
    return `properties/${section}`;
  }
  if ((LEASE_PIPELINE_TABS as readonly string[]).includes(section)) {
    return `leases/${section}`;
  }
  if ((PROMOTION_CONTENT_FILTERS as readonly string[]).includes(section)) {
    return "promotion";
  }
  if ((SERVICE_REQUEST_BUCKETS as readonly string[]).includes(section)) {
    return `services/requests/${section}`;
  }
  if ((WORK_ORDER_BUCKETS as readonly string[]).includes(section)) {
    return `services/work-orders/${section}`;
  }
  return null;
}
