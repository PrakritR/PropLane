/** Routed detail tabs for manager property inline detail (Appendix C2). */
export const PROPERTY_DETAIL_TABS = [
  "preview",
  "house-details",
  "move-in",
  "application",
  "lease",
  "tours",
  "calendar",
  "requests",
  "promotion",
] as const;

export type PropertyDetailTabId = (typeof PROPERTY_DETAIL_TABS)[number];

export const PROPERTY_DETAIL_TAB_LABELS: Record<PropertyDetailTabId, string> = {
  preview: "Preview",
  "house-details": "House details",
  "move-in": "Move-in",
  application: "Application",
  lease: "Lease",
  tours: "Tours",
  calendar: "Calendar",
  requests: "Requests",
  promotion: "Promotion",
};

/** Property detail tabs that appear before application/lease in the manager UI. */
export const PROPERTY_DETAIL_SECTION_TABS = [
  "preview",
  "house-details",
  "move-in",
] as const satisfies readonly PropertyDetailTabId[];

export type PropertyDetailSectionTabId = (typeof PROPERTY_DETAIL_SECTION_TABS)[number];

export const PROPERTY_DETAIL_TOP_TAB_LABELS = {
  details: "Details",
  tours: "Tours",
  calendar: "Calendar",
  application: "Application",
  lease: "Lease",
  requests: "Requests",
  promotion: "Promotion",
} as const;

export type PropertyDetailTopTabId = keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS;

export const PROPERTY_DETAIL_TOP_TAB_SHORT_LABELS: Partial<
  Record<PropertyDetailTopTabId, string>
> = {
  calendar: "Calendar",
  application: "Apply",
  promotion: "Promo",
};

export function propertyDetailTopNavId(tab: PropertyDetailTabId): PropertyDetailTopTabId {
  if (tab === "tours") return "tours";
  if (tab === "calendar") return "calendar";
  if (tab === "application") return "application";
  if (tab === "lease") return "lease";
  if (tab === "requests") return "requests";
  if (tab === "promotion") return "promotion";
  if ((PROPERTY_DETAIL_SECTION_TABS as readonly string[]).includes(tab)) return "details";
  return "details";
}

/** Routed detail tabs for manager resident profile (Appendix C2). */
export const RESIDENT_DETAIL_TABS = ["application", "lease", "payments", "services", "communication"] as const;

export type ResidentDetailTabId = (typeof RESIDENT_DETAIL_TABS)[number];

export const RESIDENT_DETAIL_TAB_LABELS: Record<ResidentDetailTabId, string> = {
  application: "Application",
  lease: "Lease",
  payments: "Payments",
  services: "Services",
  communication: "Communication",
};

/** Compact labels for resident detail tabs on phone-width layouts. */
export const RESIDENT_DETAIL_TAB_SHORT_LABELS: Record<ResidentDetailTabId, string> = {
  application: "Apply",
  lease: "Lease",
  payments: "Pay",
  services: "Svc",
  communication: "Comms",
};

export function parsePropertyDetailTab(raw: string | undefined | null): PropertyDetailTabId {
  if (raw === "tour-calendar") return "tours";
  if (raw === "booking-calendars") return "calendar";
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

export function propertyCalendarSubHref(
  basePath: string,
  stage: string,
  propertyKey: string,
  subTab: PropertyCalendarSubTabId,
): string {
  return `${propertyDetailHref(basePath, stage, propertyKey, "calendar")}/${subTab}`;
}

export function parseResidentDetailTab(raw: string | undefined | null): ResidentDetailTabId {
  if (raw && (RESIDENT_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as ResidentDetailTabId;
  }
  return "application";
}

export function propertyDetailHref(
  basePath: string,
  stage: string,
  propertyKey: string,
  tab: PropertyDetailTabId,
): string {
  return `${basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/${tab}`;
}

/** Manager property pipeline stages (listed / drafts / unlisted). */
export const PROPERTY_STAGES = ["listed", "drafts", "unlisted"] as const;
export type PropertyStageId = (typeof PROPERTY_STAGES)[number];

export function parsePropertyStage(raw: string | undefined | null): PropertyStageId {
  if (raw && (PROPERTY_STAGES as readonly string[]).includes(raw)) {
    return raw as PropertyStageId;
  }
  return "listed";
}

export function propertyListHref(basePath: string, stage: string): string {
  return `${basePath}/properties/${stage}`;
}

export function residentDetailHref(
  basePath: string,
  residentsTab: string,
  residentId: string,
  tab: ResidentDetailTabId,
): string {
  return `${basePath}/residents/${residentsTab}/${encodeURIComponent(residentId)}/${tab}`;
}
export function residentPaymentDetailHref(
  basePath: string,
  residentsTab: string,
  residentId: string,
  paymentId: string,
): string {
  return `${basePath}/residents/${residentsTab}/${encodeURIComponent(residentId)}/payments/${encodeURIComponent(paymentId)}`;
}


/** Portfolio calendar views — availability editing and channel bookings only. */
export const CALENDAR_VIEW_TABS = ["availability", "bookings"] as const;
export type CalendarViewTabId = (typeof CALENDAR_VIEW_TABS)[number];

export const CALENDAR_VIEW_TAB_LABELS: Record<CalendarViewTabId, string> = {
  availability: "Schedule",
  bookings: "Bookings",
};

/** Combined tours + service orders live under Operations → Tours, not Calendar. */
export const PORTFOLIO_TOURS_HREF = "/portal/tours";

export function parseCalendarViewTab(raw: string | undefined | null): CalendarViewTabId {
  if (raw === "schedule") return "availability";
  if (raw === "all" || raw === "tours" || raw === "services") return "availability";
  if (raw && (CALENDAR_VIEW_TABS as readonly string[]).includes(raw)) {
    return raw as CalendarViewTabId;
  }
  return "availability";
}

export function calendarViewHref(basePath: string, tab: CalendarViewTabId): string {
  return `${basePath}/calendar/${tab}`;
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

export function managerTourDetailHref(
  basePath: string,
  bucket: ManagerTourBucketId,
  tourId: string,
): string {
  return `${basePath}/tours/${bucket}/${encodeURIComponent(tourId)}`;
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

export function teamLinkHref(basePath: string, _tab?: TeamLinkTabId): string {
  return `${basePath}/relationships`;
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

export function applicationDetailHref(
  basePath: string,
  bucket: ApplicationBucketId,
  applicationId: string,
): string {
  return `${basePath}/applications/${bucket}/${encodeURIComponent(applicationId)}`;
}

export function applicationScreeningDetailHref(basePath: string, applicationId: string): string {
  return applicationDetailHref(basePath, "approved", applicationId);
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

export function residentApplicationDetailHref(
  basePath: string,
  bucket: ResidentApplicationBucketId,
  applicationId: string,
): string {
  return `${basePath}/applications/${bucket}/${encodeURIComponent(applicationId)}`;
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

/** Resident Lease section detail. */
export function residentLeaseDetailHref(
  basePath: string,
  bucket: ResidentLeaseBucketId,
  leaseDetailId: string,
): string {
  return `${basePath}/lease/${bucket}/${encodeURIComponent(leaseDetailId)}`;
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

/** @deprecated House details is a single page — legacy tab URLs redirect to `/move-in`. */
export const RESIDENT_MOVE_IN_TABS = ["placement", "housemates", "info", "instructions"] as const;
export type ResidentMoveInTabId = (typeof RESIDENT_MOVE_IN_TABS)[number];

/** @deprecated */
export const RESIDENT_MOVE_IN_TAB_LABELS: Record<ResidentMoveInTabId, string> = {
  placement: "Your placement",
  housemates: "Housemates",
  info: "Info & rules",
  instructions: "Instructions",
};

/** @deprecated */
export function parseResidentMoveInTab(raw: string | undefined | null): ResidentMoveInTabId {
  if (raw && (RESIDENT_MOVE_IN_TABS as readonly string[]).includes(raw)) {
    return raw as ResidentMoveInTabId;
  }
  return "placement";
}

/** @deprecated Use `${basePath}/move-in` */
export function residentMoveInHref(basePath: string, _tab?: ResidentMoveInTabId): string {
  return `${basePath}/move-in`;
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

export function leaseDetailHref(basePath: string, tab: LeasePipelineTabId, leaseId: string): string {
  return `${basePath}/leases/${tab}/${encodeURIComponent(leaseId)}`;
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

export function residentChargeDetailHref(
  basePath: string,
  bucket: PaymentBucketId,
  chargeId: string,
): string {
  return `${basePath}/payments/${bucket}/${encodeURIComponent(chargeId)}`;
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

export function serviceRequestDetailHref(
  basePath: string,
  bucket: ServiceRequestBucketId,
  requestId: string,
): string {
  return `${basePath}/services/requests/${bucket}/${encodeURIComponent(requestId)}`;
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
): string {
  return `${basePath}/services/work-orders/${bucket}/${encodeURIComponent(workOrderId)}`;
}

export function vendorListHref(basePath: string): string {
  return `${basePath}/services/vendors`;
}

export function vendorDetailHref(basePath: string, vendorId: string): string {
  return `${basePath}/services/vendors/${encodeURIComponent(vendorId)}`;
}

/** Legacy promotion content filters — routes now redirect to the unified list. */
export const PROMOTION_CONTENT_FILTERS = ["text", "image"] as const;
export type PromotionContentFilterId = (typeof PROMOTION_CONTENT_FILTERS)[number];

export function promotionListHref(basePath: string, _filter?: PromotionContentFilterId): string {
  return `${basePath}/promotion`;
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
