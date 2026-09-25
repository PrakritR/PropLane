import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowLeftRight,
  Bell,
  Calendar,
  Camera,
  CheckCircle2,
  CreditCard,
  Download,
  FileSignature,
  Lock,
  Mail,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Send,
  Share2,
  Star,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
  Eye,
  Copy,
  XCircle,
} from "lucide-react";
import {
  applicationDetailHref,
  documentRecordHref,
  inspectionDetailHref,
  leaseDetailHref,
  managerTaskDetailHref,
  managerTourDetailHref,
  paymentRecordDetailHref,
  propertyDetailHref,
  PROPERTY_DETAIL_TOP_TAB_LABELS,
  residentApplicationDetailHref,
  residentChargeDetailHref,
  residentDetailHref,
  residentLeaseDetailHref,
  residentServiceDetailHref,
  serviceRequestDetailHref,
  vendorCatalogDetailHref,
  vendorDetailHref,
  vendorInvoiceDetailHref,
  vendorJobDetailHref,
  vendorPayoutDetailHref,
  workOrderDetailHref,
  type ApplicationBucketId,
  type ApplicationDetailTabId,
  type DocumentDetailTabId,
  type LeaseDetailTabId,
  type LeasePipelineTabId,
  type ManagerTourBucketId,
  type PaymentBucketId,
  type PaymentDirectionId,
  type ResidentApplicationBucketId,
  type ResidentApplicationDetailTabId,
  type ResidentLeaseBucketId,
  type ResidentLeaseDetailTabId,
  type ResidentPaymentDetailTabId,
  type ResidentServiceDetailTabId,
  type ServiceDetailTabId,
  type ServiceRequestBucketId,
  type TourDetailTabId,
  type VendorDetailTabId,
  type VendorInvoiceDetailTabId,
  type VendorJobDetailTabId,
  type VendorPayoutDetailTabId,
  type WorkOrderBucketId,
} from "@/lib/portal-detail-routes";

/**
 * The declarative record-page registry (PLAN-0920-1058, area 1a).
 *
 * One function answers "what does this record's rail contain, and what can
 * its header do" for every role/kind the portal shows a record page for. The
 * shared trio — Communication, Documents, Activity — is appended HERE, once,
 * so no caller can forget it or spell it differently. Own-section ids/labels
 * for the kinds already live on the shared rail (property, resident, payment,
 * outgoing-payment, inspection, task, vendor) intentionally match each panel's
 * EXISTING tabs — this registry changes where the rail's data comes from, not
 * what a record's own sections are. Kinds not yet adopted onto the shell
 * (lease, application, service, tour, booking, manager document; every
 * resident and vendor kind) get their own-section shape from the plan's rail
 * table so the next phase can wire them without re-deriving it.
 */

export type PortalRole = "manager" | "resident" | "vendor";

export type ManagerRecordKind =
  | "property"
  | "resident"
  | "payment"
  | "outgoing-payment"
  | "lease"
  | "application"
  | "inspection"
  | "service"
  | "task"
  | "vendor"
  | "vendorCatalog"
  | "tour"
  | "booking"
  | "document";

export type ResidentRecordKind = "payment" | "lease" | "service" | "inspection" | "document" | "application";

export type VendorRecordKind = "job" | "invoice" | "payout";

export type RecordKind = ManagerRecordKind | ResidentRecordKind | VendorRecordKind;

export type RecordSectionItem = {
  id: string;
  label: string;
  href: (recordId: string) => string;
};

export type RecordSectionGroup = {
  label: string;
  items: RecordSectionItem[];
};

export type RecordHeaderAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  tone?: "default" | "primary" | "danger";
};

export type RecordSections = {
  groups: RecordSectionGroup[];
  /** The active section's header icons — see `recordSections`'s `activeSectionId` param. */
  headerActions: RecordHeaderAction[];
};

/** Extra ids a kind's href builder needs beyond the record id itself — every field optional, sensibly defaulted. */
export type RecordSectionContext = {
  basePath?: string;
  /** property */
  stage?: string;
  /** resident */
  residentsTab?: string;
  /** payment / outgoing-payment / application (manager+resident: the list bucket the record lives in) */
  direction?: PaymentDirectionId;
  bucket?: string;
  /** inspection */
  inspectionKind?: "move-in" | "move-out";
  /** task */
  taskListTab?: string;
  /** lease */
  leaseListTab?: LeasePipelineTabId;
  /** tour */
  tourBucket?: ManagerTourBucketId;
  /** service — an add-on request or a maintenance work order share the one rail. */
  serviceKind?: "request" | "work-order";
  serviceBucket?: ServiceRequestBucketId | WorkOrderBucketId;
};

type OwnGroup = { label: string; ids: Array<{ id: string; label: string }> };

type KindDef = {
  basePathDefault: string;
  ownGroups: OwnGroup[];
  /** The default header icon set — used for a section with no entry of its own below. */
  headerActions: RecordHeaderAction[];
  /**
   * A section's own header icon set, keyed by section id, when it differs
   * from the kind's default (a document viewer or a Payments tab carries its
   * own actions instead of the record's general set). A section not listed
   * here falls back to `headerActions`.
   */
  sectionActions?: Record<string, RecordHeaderAction[]>;
  /** Communication is part of the shared trio for every kind except where explicitly opted out (C229: a property's own conversations live only on the portal-wide Communication page now). Defaults to true when omitted. */
  hasCommunication?: boolean;
  hasDocuments: boolean;
  hasActivity: boolean;
  href: (ctx: RecordSectionContext) => (recordId: string, tab: string) => string;
};

/** Generic `${basePath}/<slug>/<id>/<tab>` route for a kind this phase does not adopt yet — nothing real navigates it today (phase 1C wires the panel), and every such path resolves under the portal/resident/vendor optional catch-all routes. */
function genericHref(basePath: string, slug: string): (recordId: string, tab: string) => string {
  return (recordId, tab) => `${basePath}/${slug}/${encodeURIComponent(recordId)}/${tab}`;
}

const MANAGER_DEFS: Record<ManagerRecordKind, KindDef> = {
  property: {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Property", ids: ["preview", "house-details", "move-in"].map((id) => ({ id, label: PROPERTY_DETAIL_TOP_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS] })) },
      { label: "Leasing", ids: ["tours", "bookings", "application", "lease"].map((id) => ({ id, label: PROPERTY_DETAIL_TOP_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS] })) },
      // "requests" reads "Services" everywhere it is shown — the shared
      // rail matches the panel's own tab, not the schema/route id.
      { label: "Operations", ids: ["requests", "promotion", "ai-info"].map((id) => ({ id, label: PROPERTY_DETAIL_TOP_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS] })) },
    ],
    headerActions: [
      { id: "view-public", label: "View public", icon: Eye },
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "share", label: "Share", icon: Share2 },
      { id: "copy", label: "Copy", icon: Copy },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    // C229/C230 (captain, BUILD-WAVE2 §4): a property's own Communication and
    // Documents rail items are removed — conversations and files live only on
    // the portal-wide Communication/Documents pages now.
    hasCommunication: false,
    hasDocuments: false,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const stage = ctx.stage ?? "all";
      return (recordId, tab) => propertyDetailHref(basePath, stage, recordId, tab as never);
    },
  },
  resident: {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Resident", ids: [
        { id: "overview", label: "Overview" },
        { id: "application", label: "Application" },
        { id: "background-check", label: "Background check" },
      ] },
      { label: "Home", ids: [
        { id: "lease", label: "Lease" },
        { id: "payments", label: "Payments" },
        { id: "services", label: "Services" },
        { id: "inspections", label: "Inspections" },
        { id: "tours", label: "Tours" },
      ] },
    ],
    headerActions: [
      { id: "message", label: "Message", icon: Mail },
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "share", label: "Share", icon: Share2 },
      { id: "archive", label: "Archive", icon: Archive },
    ],
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const residentsTab = ctx.residentsTab ?? "current";
      return (recordId, tab) => residentDetailHref(basePath, residentsTab, recordId, tab as never);
    },
  },
  payment: {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Payment", ids: [{ id: "overview", label: "Overview" }] },
      { label: "Linked", ids: [
        { id: "service", label: "Service" },
        { id: "vendor", label: "Vendor" },
        { id: "resident", label: "Resident" },
      ] },
    ],
    headerActions: [
      { id: "record-payment", label: "Record payment", icon: CreditCard },
      { id: "send-reminder", label: "Send reminder", icon: Send },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const direction = ctx.direction ?? "incoming";
      const bucket = (ctx.bucket ?? "pending") as never;
      return (recordId, tab) => paymentRecordDetailHref(basePath, direction, bucket, recordId, tab as never);
    },
  },
  "outgoing-payment": {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Payment", ids: [{ id: "overview", label: "Overview" }] },
      { label: "Linked", ids: [
        { id: "service", label: "Service" },
        { id: "vendor", label: "Vendor" },
        { id: "resident", label: "Resident" },
      ] },
    ],
    headerActions: [
      { id: "pay-now", label: "Pay now", icon: CreditCard },
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const direction = ctx.direction ?? "outgoing";
      const bucket = (ctx.bucket ?? "pending") as never;
      return (recordId, tab) => paymentRecordDetailHref(basePath, direction, bucket, recordId, tab as never);
    },
  },
  lease: {
    basePathDefault: "/portal",
    // PLAN-0921-1029, area 2: Overview · Lease document · Payments ·
    // Communication. "Terms", "Signatures" and "Amendments" fold into the
    // Lease document view instead of staying separate tabs.
    ownGroups: [
      { label: "Lease", ids: [
        { id: "overview", label: "Overview" },
        { id: "lease-document", label: "Lease document" },
      ] },
      { label: "Linked", ids: [{ id: "payments", label: "Payments" }] },
    ],
    headerActions: [
      { id: "send", label: "Send for signature", icon: Send },
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "share", label: "Share", icon: Share2 },
      { id: "archive", label: "Archive", icon: Archive },
    ],
    sectionActions: {
      "lease-document": [
        { id: "send", label: "Send for signature", icon: Send },
        { id: "new-version", label: "Generate new version", icon: Plus },
        { id: "upload", label: "Upload a PDF", icon: Upload },
        { id: "download", label: "Download", icon: Download },
      ],
      payments: [
        { id: "add-charge", label: "Add charge", icon: Plus },
        { id: "send-reminder", label: "Send reminder", icon: Bell },
        { id: "export", label: "Export", icon: Download },
      ],
      communication: [
        { id: "compose", label: "New message", icon: Mail },
        { id: "archive-thread", label: "Archive thread", icon: Archive },
      ],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const listTab = ctx.leaseListTab ?? "manager";
      return (recordId, tab) => leaseDetailHref(basePath, listTab, recordId, tab as LeaseDetailTabId);
    },
  },
  application: {
    basePathDefault: "/portal",
    // PLAN-0921-1029, area 2: Overview · Application form · Screening ·
    // Communication. "Applicants" folds into the Application form view;
    // "Decision" folds into Overview's own fact cards.
    ownGroups: [{ label: "Application", ids: [
      { id: "overview", label: "Overview" },
      { id: "application-form", label: "Application form" },
      { id: "screening", label: "Screening" },
    ] }],
    headerActions: [
      { id: "approve", label: "Approve", icon: CheckCircle2 },
      { id: "decline", label: "Decline", icon: XCircle, tone: "danger" },
      { id: "share", label: "Share", icon: Share2 },
      { id: "archive", label: "Archive", icon: Archive },
    ],
    sectionActions: {
      // C049 (studio decision): "Request more info" had no real handler
      // anywhere in the app — dropped rather than shipped as a dead action.
      // (This whole `sectionActions` map is currently unread by
      // PortalRecordSectionChrome — the application record's real header
      // dock is `renderApplicationRowActions` in pro-applications.tsx — so
      // this never rendered either way; removed for hygiene.)
      "application-form": [
        { id: "approve", label: "Approve", icon: CheckCircle2 },
        { id: "download", label: "Download", icon: Download },
        { id: "print", label: "Print", icon: Printer },
      ],
      screening: [
        { id: "approve", label: "Approve", icon: CheckCircle2 },
        { id: "rerun", label: "Re-run screening", icon: RefreshCw },
        { id: "download-report", label: "Download report", icon: Download },
      ],
      communication: [
        { id: "compose", label: "New message", icon: Mail },
        { id: "archive-thread", label: "Archive thread", icon: Archive },
      ],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const bucket = (ctx.bucket ?? "pending") as ApplicationBucketId;
      return (recordId, tab) => applicationDetailHref(basePath, bucket, recordId, tab as ApplicationDetailTabId);
    },
  },
  inspection: {
    basePathDefault: "/portal",
    // PLAN-0921-1029, area 2: Overview · Rooms · Payments · Communication.
    // "Resident" and "Vendor" fold into Overview's Home fact card.
    ownGroups: [
      { label: "Inspection", ids: [
        { id: "overview", label: "Overview" },
        { id: "rooms", label: "Rooms" },
      ] },
      { label: "Linked", ids: [{ id: "payments", label: "Payments" }] },
    ],
    headerActions: [
      { id: "request-photos", label: "Request photos", icon: Camera },
      { id: "download-report", label: "Download report", icon: Download },
      { id: "lock", label: "Lock", icon: Lock },
    ],
    sectionActions: {
      rooms: [
        { id: "add-photos", label: "Add photos", icon: Camera },
        { id: "download-report", label: "Download PDF", icon: Download },
        { id: "lock", label: "Lock", icon: Lock },
      ],
      payments: [
        { id: "add-charge", label: "Add charge", icon: Plus },
        { id: "export", label: "Export", icon: Download },
      ],
      communication: [
        { id: "compose", label: "New message", icon: Mail },
        { id: "archive-thread", label: "Archive thread", icon: Archive },
      ],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const kind = ctx.inspectionKind ?? "move-in";
      return (recordId, tab) => inspectionDetailHref(basePath, kind, recordId, tab as never);
    },
  },
  service: {
    basePathDefault: "/portal",
    // PLAN-0921-1029, area 2: Overview · Vendor & schedule · Photos ·
    // Payments · Communication. "Vendor & bids" and "Schedule" merge into one
    // section; "Invoice" folds into Payments (a service's invoice IS its charge).
    ownGroups: [
      { label: "Service", ids: [
        { id: "overview", label: "Overview" },
        { id: "vendor-schedule", label: "Vendor & schedule" },
        { id: "photos", label: "Photos" },
      ] },
      { label: "Linked", ids: [{ id: "payments", label: "Payments" }] },
    ],
    headerActions: [
      { id: "assign-vendor", label: "Assign vendor", icon: UserPlus },
      { id: "schedule", label: "Schedule", icon: Calendar },
      { id: "close", label: "Close", icon: CheckCircle2 },
      // Only rendered once the service is completed and a vendor is assigned
      // (gated in pro-work-orders-panel.tsx's headerActions filter).
      { id: "review", label: "Leave a review", icon: Star },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    sectionActions: {
      "vendor-schedule": [
        { id: "assign-vendor", label: "Assign vendor", icon: UserPlus },
        { id: "propose-time", label: "Propose a time", icon: Calendar },
        { id: "invite-vendor", label: "Invite another vendor", icon: Mail },
      ],
      photos: [
        { id: "add-photos", label: "Add photos", icon: Camera },
        { id: "download-all", label: "Download all", icon: Download },
      ],
      payments: [
        { id: "add-charge", label: "Add charge", icon: Plus },
        { id: "export", label: "Export", icon: Download },
      ],
      communication: [
        { id: "compose", label: "New message", icon: Mail },
        { id: "archive-thread", label: "Archive thread", icon: Archive },
      ],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const serviceKind = ctx.serviceKind ?? "work-order";
      if (serviceKind === "request") {
        const bucket = (ctx.serviceBucket as ServiceRequestBucketId) ?? "pending";
        return (recordId, tab) => serviceRequestDetailHref(basePath, bucket, recordId, tab as ServiceDetailTabId);
      }
      const bucket = (ctx.serviceBucket as WorkOrderBucketId) ?? "open";
      return (recordId, tab) => workOrderDetailHref(basePath, bucket, recordId, tab as ServiceDetailTabId);
    },
  },
  task: {
    basePathDefault: "/portal",
    // PLAN-0921-1029, area 2: Overview · Communication. "Payments", "Vendor"
    // and "Resident" fold into Overview's own fact cards.
    ownGroups: [
      { label: "Task", ids: [{ id: "overview", label: "Overview" }] },
    ],
    headerActions: [
      { id: "mark-done", label: "Mark done", icon: CheckCircle2 },
      { id: "reassign", label: "Reassign", icon: RefreshCw },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    sectionActions: {
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const listTab = ctx.taskListTab ?? "in-progress";
      return (recordId, tab) => managerTaskDetailHref(basePath, listTab as never, recordId, tab as never);
    },
  },
  vendor: {
    basePathDefault: "/portal",
    // PLAN-0921-1029, area 2: Overview · Services · Invoices · Communication ·
    // Documents. "Profile", "Jobs" and "Check-ins" fold into Overview's own
    // fact cards (Contact, Services).
    ownGroups: [
      { label: "Vendor", ids: [
        { id: "overview", label: "Overview" },
        { id: "services", label: "Services" },
        { id: "invoices", label: "Invoices" },
        { id: "reviews", label: "Reviews" },
      ] },
    ],
    headerActions: [
      { id: "message", label: "Message", icon: Mail },
      { id: "invite", label: "Invite", icon: UserPlus },
      { id: "remove", label: "Remove", icon: UserMinus, tone: "danger" },
    ],
    sectionActions: {
      services: [
        { id: "new-service", label: "New service", icon: Plus },
        { id: "message", label: "Message", icon: Mail },
      ],
      invoices: [
        { id: "approve-invoice", label: "Approve invoice", icon: CheckCircle2 },
        { id: "export", label: "Export", icon: Download },
      ],
      communication: [{ id: "compose", label: "New message", icon: Mail }],
      documents: [
        { id: "upload", label: "Upload", icon: Upload },
        { id: "download-all", label: "Download all", icon: Download },
      ],
    },
    hasDocuments: true,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      return (recordId, tab) => vendorDetailHref(basePath, recordId, tab as never);
    },
  },
  vendorCatalog: {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Vendor", ids: [
        { id: "overview", label: "Overview" },
        { id: "pricing", label: "Pricing" },
      ] },
      { label: "Work", ids: [
        { id: "jobs", label: "Jobs" },
        { id: "reviews", label: "Reviews" },
      ] },
    ],
    headerActions: [
      { id: "add", label: "Add to your vendors", icon: UserPlus },
      { id: "email", label: "Email", icon: Mail },
      { id: "share", label: "Share", icon: Share2 },
    ],
    sectionActions: {
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: true,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      return (recordId, tab) => vendorCatalogDetailHref(basePath, recordId, tab as VendorDetailTabId);
    },
  },
  tour: {
    basePathDefault: "/portal",
    // PLAN-0921-1029, area 2: Overview · Communication. "Prospect", "Slot"
    // and "Follow-up" fold into Overview's own fact cards.
    ownGroups: [{ label: "Tour", ids: [{ id: "overview", label: "Overview" }] }],
    headerActions: [
      { id: "confirm", label: "Confirm", icon: CheckCircle2 },
      { id: "reschedule", label: "Reschedule", icon: RefreshCw },
      { id: "decline", label: "Decline", icon: XCircle, tone: "danger" },
    ],
    sectionActions: {
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const bucket = ctx.tourBucket ?? "pending";
      return (recordId, tab) => managerTourDetailHref(basePath, bucket, recordId, tab as TourDetailTabId);
    },
  },
  booking: {
    basePathDefault: "/portal",
    ownGroups: [{ label: "Booking", ids: [
      { id: "overview", label: "Overview" },
      { id: "guest", label: "Guest" },
      { id: "charges", label: "Charges" },
    ] }],
    // "Record payment" is dropped by the page itself when this booking has no
    // charge path yet — never shown as a dead "Coming soon" action
    // (docs/agents/record-page.md § Known gap carve-out for this one id).
    headerActions: [
      { id: "edit-dates", label: "Edit dates", icon: Pencil },
      { id: "move-room", label: "Move room", icon: ArrowLeftRight },
      { id: "record-payment", label: "Record payment", icon: CreditCard },
      { id: "cancel", label: "Cancel", icon: XCircle, tone: "danger" },
    ],
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => genericHref(ctx.basePath ?? "/portal", "bookings"),
  },
  document: {
    basePathDefault: "/portal",
    ownGroups: [{ label: "Document", ids: [
      { id: "preview", label: "Preview" },
      { id: "details", label: "Details" },
    ] }],
    headerActions: [
      { id: "download", label: "Download", icon: Download },
      { id: "share", label: "Share", icon: Share2 },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    // The Details tab is metadata, not the file itself — nothing to download
    // from it, so it drops that one action rather than offering a dead click.
    sectionActions: {
      details: [
        { id: "share", label: "Share", icon: Share2 },
        { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
      ],
    },
    hasDocuments: false,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      return (recordId, tab) => documentRecordHref(basePath, recordId, tab as DocumentDetailTabId);
    },
  },
};

const RESIDENT_DEFS: Record<ResidentRecordKind, KindDef> = {
  payment: {
    basePathDefault: "/resident",
    // PLAN-0921-1029, area 2: Overview · Communication. "Receipt" folds into
    // the existing "Download receipt" header action.
    ownGroups: [{ label: "Payment", ids: [{ id: "overview", label: "Overview" }] }],
    headerActions: [
      { id: "pay", label: "Pay", icon: CreditCard },
      { id: "download-receipt", label: "Download receipt", icon: Download },
    ],
    sectionActions: {
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/resident";
      const bucket = (ctx.bucket ?? "pending") as PaymentBucketId;
      return (recordId, tab) => residentChargeDetailHref(basePath, bucket, recordId, tab as ResidentPaymentDetailTabId);
    },
  },
  lease: {
    basePathDefault: "/resident",
    // PLAN-0921-1029, area 2: Overview · Lease document · Payments ·
    // Communication. "Terms" and "Signatures" fold into the Lease document view.
    ownGroups: [
      { label: "Lease", ids: [
        { id: "overview", label: "Overview" },
        { id: "lease-document", label: "Lease document" },
      ] },
      { label: "Linked", ids: [{ id: "payments", label: "Payments" }] },
    ],
    headerActions: [
      { id: "sign", label: "Sign", icon: FileSignature },
      { id: "download", label: "Download", icon: Download },
    ],
    sectionActions: {
      "lease-document": [
        { id: "sign", label: "Sign this lease", icon: FileSignature },
        { id: "download", label: "Download", icon: Download },
        { id: "ask", label: "Ask a question", icon: Mail },
      ],
      payments: [
        { id: "pay", label: "Pay", icon: CreditCard },
        { id: "receipts", label: "Receipts", icon: Download },
      ],
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/resident";
      const bucket = (ctx.bucket ?? "pending") as ResidentLeaseBucketId;
      return (recordId, tab) => residentLeaseDetailHref(basePath, bucket, recordId, tab as ResidentLeaseDetailTabId);
    },
  },
  application: {
    basePathDefault: "/resident",
    // PLAN-0921-1029, area 2 (new kind): Overview · Application form ·
    // Communication.
    ownGroups: [{ label: "Application", ids: [
      { id: "overview", label: "Overview" },
      { id: "application-form", label: "Application form" },
    ] }],
    headerActions: [
      { id: "sign-lease", label: "Sign your lease", icon: Send },
      { id: "download", label: "Download", icon: Download },
      { id: "message", label: "Message manager", icon: Mail },
    ],
    sectionActions: {
      "application-form": [
        { id: "edit", label: "Edit my answers", icon: Pencil },
        { id: "download", label: "Download", icon: Download },
      ],
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/resident";
      const bucket = (ctx.bucket ?? "approved") as ResidentApplicationBucketId;
      return (recordId, tab) => residentApplicationDetailHref(basePath, bucket, recordId, tab as ResidentApplicationDetailTabId);
    },
  },
  service: {
    basePathDefault: "/resident",
    ownGroups: [{ label: "Service", ids: [
      { id: "overview", label: "Overview" },
      { id: "updates", label: "Updates" },
      { id: "photos", label: "Photos" },
    ] }],
    headerActions: [
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "cancel", label: "Cancel", icon: XCircle, tone: "danger" },
      { id: "message", label: "Message manager", icon: Mail },
    ],
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/resident";
      return (recordId, tab) => residentServiceDetailHref(basePath, recordId, tab as ResidentServiceDetailTabId);
    },
  },
  inspection: {
    basePathDefault: "/resident",
    ownGroups: [{ label: "Inspection", ids: [
      { id: "overview", label: "Overview" },
      { id: "photos", label: "Photos" },
      { id: "report", label: "Report" },
    ] }],
    headerActions: [
      { id: "add-photos", label: "Add photos", icon: Camera },
      { id: "download", label: "Download", icon: Download },
    ],
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => genericHref(ctx.basePath ?? "/resident", "inspections"),
  },
  document: {
    basePathDefault: "/resident",
    ownGroups: [{ label: "Document", ids: [
      { id: "preview", label: "Preview" },
      { id: "details", label: "Details" },
    ] }],
    headerActions: [{ id: "download", label: "Download", icon: Download }],
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => genericHref(ctx.basePath ?? "/resident", "documents"),
  },
};

const VENDOR_DEFS: Record<VendorRecordKind, KindDef> = {
  job: {
    basePathDefault: "/vendor",
    // PLAN-0921-1029, area 2 (vendor-portal Service): Overview · Schedule ·
    // Invoice · Communication. "Scope & photos" folds into Overview's Job
    // fact card.
    ownGroups: [{ label: "Service", ids: [
      { id: "overview", label: "Overview" },
      { id: "schedule", label: "Schedule" },
      { id: "invoice", label: "Invoice" },
    ] }],
    headerActions: [
      { id: "accept", label: "Accept", icon: CheckCircle2 },
      { id: "schedule", label: "Schedule", icon: Calendar },
      { id: "submit-invoice", label: "Submit invoice", icon: Send },
    ],
    sectionActions: {
      schedule: [
        { id: "propose-time", label: "Propose a time", icon: Calendar },
        { id: "message", label: "Message manager", icon: Mail },
      ],
      invoice: [
        { id: "submit-invoice", label: "Submit invoice", icon: Send },
        { id: "download", label: "Download", icon: Download },
      ],
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/vendor";
      return (recordId, tab) => vendorJobDetailHref(basePath, recordId, tab as VendorJobDetailTabId);
    },
  },
  invoice: {
    basePathDefault: "/vendor",
    ownGroups: [{ label: "Invoice", ids: [
      { id: "overview", label: "Overview" },
      { id: "lines", label: "Lines" },
      { id: "payout", label: "Payout" },
    ] }],
    headerActions: [
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "withdraw", label: "Withdraw", icon: XCircle, tone: "danger" },
      { id: "download", label: "Download", icon: Download },
      { id: "submit", label: "Submit", icon: Send },
    ],
    hasDocuments: true,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/vendor";
      return (recordId, tab) => vendorInvoiceDetailHref(basePath, recordId, tab as VendorInvoiceDetailTabId);
    },
  },
  payout: {
    basePathDefault: "/vendor",
    ownGroups: [{ label: "Payout", ids: [
      { id: "overview", label: "Overview" },
      { id: "included-invoices", label: "Included invoices" },
    ] }],
    headerActions: [{ id: "download", label: "Download", icon: Download }],
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/vendor";
      return (recordId, tab) => vendorPayoutDetailHref(basePath, recordId, tab as VendorPayoutDetailTabId);
    },
  },
};

const DEFS: Record<PortalRole, Record<string, KindDef>> = {
  manager: MANAGER_DEFS,
  resident: RESIDENT_DEFS,
  vendor: VENDOR_DEFS,
};

/** Every (role, kind) pair the registry answers for — used by the coverage test. */
export const ALL_RECORD_KINDS: Array<{ role: PortalRole; kind: string }> = (
  Object.entries(DEFS) as Array<[PortalRole, Record<string, KindDef>]>
).flatMap(([role, defs]) => Object.keys(defs).map((kind) => ({ role, kind })));

/**
 * A record kind's rail + header, for one role. The shared trio (Communication,
 * always; Documents and Activity, only where this kind's row in the rail
 * table lists them) is appended here — never build it at the call site.
 */
export function recordSections(
  role: PortalRole,
  kind: string,
  ctx: RecordSectionContext = {},
  /** The section currently open — resolves that section's own header icons, falling back to the kind's default set. */
  activeSectionId?: string,
): RecordSections {
  const def = DEFS[role]?.[kind];
  if (!def) {
    throw new Error(`recordSections: no registry entry for ${role}/${kind}`);
  }
  const hrefFor = def.href(ctx);
  const groups: RecordSectionGroup[] = def.ownGroups
    .map((group) => ({
      label: group.label,
      items: group.ids.map(({ id, label }) => ({
        id,
        label,
        href: (recordId: string) => hrefFor(recordId, id),
      })),
    }))
    .filter((group) => group.items.length > 0);

  const trioItems: RecordSectionItem[] = [];
  if (def.hasCommunication !== false) {
    trioItems.push({ id: "communication", label: "Communication", href: (recordId: string) => hrefFor(recordId, "communication") });
  }
  if (def.hasDocuments) {
    trioItems.push({ id: "documents", label: "Documents", href: (recordId: string) => hrefFor(recordId, "documents") });
  }
  if (def.hasActivity) {
    trioItems.push({ id: "activity", label: "Activity", href: (recordId: string) => hrefFor(recordId, "activity") });
  }
  // No group label: Communication/Documents/Activity read as universal record
  // chrome, not a labeled category the way "Money" or "People" are.
  if (trioItems.length > 0) {
    groups.push({ label: "", items: trioItems });
  }

  const headerActions =
    (activeSectionId && def.sectionActions?.[activeSectionId]) || def.headerActions;

  return {
    groups,
    headerActions,
  };
}

/** The ids the registry always owns — a caller passing one of these itself is a bug. */
export const RECORD_TRIO_IDS = ["communication", "documents", "activity"] as const;
