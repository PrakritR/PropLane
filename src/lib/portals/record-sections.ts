import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Bell,
  Calendar,
  Camera,
  CircleOff,
  CheckCircle2,
  CreditCard,
  FileText,
  MessageSquare,
  Wallet,
  Download,
  HandCoins,
  FileSignature,
  Lock,
  Shield,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Share2,
  Star,
  Trash2,
  Upload,
  UserPlus,
  Copy,
  XCircle,} from "lucide-react";
import {
  applicationDetailHref,
  bookingRecordHref,
  documentRecordHref,
  inspectionDetailHref,
  leaseDetailHref,
  managerTaskDetailHref,
  managerTourDetailHref,
  outgoingPaymentRecordHref,
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
  type BookingDetailTabId,
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
  | "vendor-bill"
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

/**
 * C011: one fixed relative order for header icons across every kind, so a
 * manager who learns "edit is left of share, delete is always last and red"
 * on Properties finds the same order on Residents, Payments, Leases, and
 * every other record. This does not force every kind to CARRY every action —
 * Payment has no edit/share/copy, Resident has no delete — it only fixes the
 * order of whichever of these a kind's own array actually authors. The
 * kind's first action (its own "next step" — View public, Message, Record
 * payment, …) is never reordered: only what follows it, plus Delete, which
 * always sorts last regardless of where the kind's array put it.
 */
const HEADER_ACTION_ORDER = ["edit", "share", "export", "download", "copy", "duplicate", "unlist", "archive"];
const DELETE_ACTION_ID = "delete";

/** Applied once, centrally, in `recordSections()` — never re-sort a kind's array at its own definition site. */
export function orderHeaderActions(actions: RecordHeaderAction[]): RecordHeaderAction[] {
  if (actions.length <= 1) return actions;
  const [primary, ...rest] = actions;
  const deleteIndex = rest.findIndex((a) => a.id === DELETE_ACTION_ID);
  const deleteAction = deleteIndex === -1 ? null : rest[deleteIndex]!;
  const withoutDelete = deleteIndex === -1 ? rest : rest.filter((_, i) => i !== deleteIndex);

  // Only actions that appear in HEADER_ACTION_ORDER are reordered, and only
  // relative to ONE ANOTHER's slots — a kind-specific action (Approve,
  // Decline, Reassign, Send for signature, …) never moves, so this can only
  // fix the relative order among edit/share/export/duplicate, never
  // reshuffle a kind's own action set.
  const rankedSlots = withoutDelete
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => HEADER_ACTION_ORDER.includes(action.id));
  const sortedRanked = [...rankedSlots].sort(
    (a, b) => HEADER_ACTION_ORDER.indexOf(a.action.id) - HEADER_ACTION_ORDER.indexOf(b.action.id),
  );
  const result = [...withoutDelete];
  rankedSlots.forEach(({ index }, i) => {
    result[index] = sortedRanked[i]!.action;
  });

  return deleteAction ? [primary!, ...result, deleteAction] : [primary!, ...result];
}

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
  /** Section ids to leave out of this record's rail (e.g. a lease's Audit trail before it is executed). */
  hiddenSections?: readonly string[];
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
      { label: "Property", ids: ["preview", "house-details"].map((id) => ({ id, label: PROPERTY_DETAIL_TOP_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS] })) },
      { label: "Leasing", ids: [
        { id: "application", label: "Applications" },
        { id: "lease", label: "Lease" },
        // Move-in forms are part of leasing, between the lease and the price (captain, Oct 3).
        { id: "move-in", label: "Move-in" },
        { id: "pricing", label: "Pricing" },
      ] },
      // "requests" reads "Services" everywhere it is shown — the shared
      // rail matches the panel's own tab, not the schema/route id.
      { label: "Operations", ids: ["requests", "promotion", "ai-info"].map((id) => ({ id, label: PROPERTY_DETAIL_TOP_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TOP_TAB_LABELS] })) },
    ],
    headerActions: [
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "share", label: "Share", icon: Share2 },
      { id: "duplicate", label: "Duplicate property", icon: Copy },
      { id: "unlist", label: "Unlist", icon: CircleOff },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    sectionActions: {
      preview: [
        { id: "edit", label: "Edit", icon: Pencil },
        { id: "share", label: "Share", icon: Share2 },
        { id: "duplicate", label: "Duplicate property", icon: Copy },
        { id: "unlist", label: "Unlist", icon: CircleOff },
        { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
      ],
    },
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
        { id: "move-in", label: "Move-in" },
        { id: "payments", label: "Payments" },
        { id: "services", label: "Services" },
        { id: "inspections", label: "Inspections" },
        { id: "tours", label: "Tours" },
      ] },
    ],
    headerActions: [
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "share", label: "Share", icon: Share2 },
      { id: "archive", label: "Archive", icon: Archive },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
      { id: "message", label: "Message", icon: Mail, tone: "primary" },
    ],
    sectionActions: {
      application: [
        { id: "approve", label: "Approve", icon: CheckCircle2, tone: "primary" },
        { id: "decline", label: "Decline", icon: XCircle, tone: "danger" },
        { id: "edit", label: "Edit", icon: Pencil },
        { id: "download", label: "Download PDF", icon: Download },
      ],
      "background-check": [
        { id: "run-check", label: "Run check", icon: Shield, tone: "primary" },
        { id: "upload", label: "Upload report", icon: Upload },
      ],
      lease: [
        { id: "send-lease", label: "Send lease", icon: Send, tone: "primary" },
        { id: "remind-sign", label: "Remind to sign", icon: Bell },
        { id: "download", label: "Download", icon: Download },
        { id: "upload", label: "Upload", icon: Upload },
      ],
      payments: [
        { id: "remind-payment", label: "Payment reminder", icon: Bell },
        { id: "add-charge", label: "Add charge", icon: Plus, tone: "primary" },
      ],
      services: [{ id: "add-service", label: "Add service", icon: Plus, tone: "primary" }],
      inspections: [{ id: "add-inspection", label: "Add inspection", icon: Plus, tone: "primary" }],
      tours: [{ id: "add-tour", label: "Add tour", icon: Plus, tone: "primary" }],
      documents: [{ id: "upload", label: "Add document", icon: Upload, tone: "primary" }],
    },
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
    ownGroups: [{ label: "", ids: [{ id: "overview", label: "Payment" }] }],
    headerActions: [
      { id: "take-payment", label: "Take payment", icon: HandCoins },
      { id: "mark-paid", label: "Mark paid offline", icon: CheckCircle2 },
      { id: "send-reminder", label: "Send reminder", icon: Bell },
      { id: "download", label: "Download", icon: Download },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    hasDocuments: false,
    hasActivity: false,
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
  "vendor-bill": {
    basePathDefault: "/portal",
    // Operations > Outgoing payments: one vendor bill or payout (PLAN studio-redesign-0929, C2-OUT2).
    // Payment · Communication. The page renders the set below in its own order (Pay now right-most),
    // dropping what the server cannot do for that bill; Dispute / Void request have no handler yet.
    ownGroups: [{ label: "", ids: [{ id: "overview", label: "Payment" }] }],
    headerActions: [
      { id: "view-invoice", label: "View invoice", icon: FileText },
      { id: "schedule", label: "Schedule payment", icon: Calendar },
      { id: "message", label: "Message vendor", icon: MessageSquare },
      { id: "mark-paid", label: "Mark paid", icon: CheckCircle2 },
      { id: "delete", label: "Delete bill", icon: Trash2, tone: "danger" },
      { id: "pay-now", label: "Pay now", icon: Wallet, tone: "primary" },
    ],
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      return (recordId, tab) => outgoingPaymentRecordHref(basePath, recordId, tab as never);
    },
  },
  lease: {
    basePathDefault: "/portal",
    // CX-RC1: Lease (who signed, terms, document, audit trail, lease-first answers) · Communication.
    // Legacy `audit-trail` / `answers` routes still resolve to the Lease section (aliases).
    ownGroups: [{ label: "Lease", ids: [{ id: "overview", label: "Lease" }] }],
    headerActions: [
      { id: "send", label: "Send lease", icon: Send },
      { id: "edit", label: "Edit lease", icon: Pencil },
      { id: "download", label: "Download", icon: Download },
    ],
    sectionActions: {
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
    // Application · Background check · Communication (CX-RC2). The Application section is the
    // record's first, so its route id stays `overview`; the grouped answers, the shared-room
    // card and the status facts all live in it rather than in a second "Overview".
    ownGroups: [{ label: "Application", ids: [
      { id: "overview", label: "Application" },
      { id: "screening", label: "Background check" },
    ] }],
    headerActions: [
      { id: "approve", label: "Approve", icon: CheckCircle2 },
      { id: "decline", label: "Decline", icon: XCircle, tone: "danger" },
    ],
    sectionActions: {
      screening: [
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
    ownGroups: [{ label: "Inspection", ids: [{ id: "overview", label: "Inspection" }] }],
    headerActions: [
      { id: "add-photos", label: "Add photos", icon: Camera },
      { id: "download-report", label: "Download report", icon: Download },
      { id: "lock", label: "Complete & lock", icon: Lock, tone: "primary" },
    ],
    sectionActions: {
      overview: [
        { id: "add-photos", label: "Add photos", icon: Camera },
        { id: "download-report", label: "Download report", icon: Download },
        { id: "lock", label: "Complete & lock", icon: Lock, tone: "primary" },
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
    // Service · Vendor & schedule · (Linked) Incoming payments · Outgoing payments · Communication.
    // The old Overview and Photos are one Service tab (the resident's photos are a strip inside it);
    // Payments split into what the resident pays in and what the manager pays vendors out.
    ownGroups: [
      { label: "Service", ids: [
        { id: "service", label: "Service" },
        { id: "vendor-schedule", label: "Vendor & schedule" },
      ] },
      { label: "Linked", ids: [
        { id: "incoming-payments", label: "Incoming payments" },
        { id: "outgoing-payments", label: "Outgoing payments" },
      ] },
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
        { id: "invite-vendor", label: "Request bids", icon: Mail },
      ],
      "incoming-payments": [
        { id: "add-charge", label: "Add charge", icon: Plus },
        { id: "export", label: "Export", icon: Download },
      ],
      "outgoing-payments": [
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
    // Studio plan services-vendors-1004: TASK: Task · Linked, then Communication. The Task section keeps
    // the `overview` id so every saved task link still lands.
    ownGroups: [
      { label: "Task", ids: [
        { id: "overview", label: "Task" },
        { id: "linked", label: "Linked" },
      ] },
    ],
    // Edit · Assign · Schedule · Complete (the filled primary, `primaryId="complete"`) · Delete (last, red).
    headerActions: [
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "assign", label: "Assign", icon: UserPlus },
      { id: "schedule", label: "Schedule", icon: Calendar },
      { id: "complete", label: "Complete", icon: CheckCircle2, tone: "primary" },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    sectionActions: {
      communication: [{ id: "compose", label: "New message", icon: Mail }],
    },
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const listTab = ctx.taskListTab ?? "open";
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
        { id: "overview", label: "Vendor" },
        { id: "services", label: "Services" },
        { id: "invoices", label: "Outgoing payments" },
        { id: "reviews", label: "Reviews" },
      ] },
    ],
    // Edit · Invite · Message · Remove. Message is the filled primary (the most common act, so the
    // vendor page passes `primaryId="message"`); Remove is the red Trash2 and always last.
    headerActions: [
      { id: "edit", label: "Edit vendor", icon: Pencil },
      { id: "invite", label: "Invite to PropLane", icon: UserPlus },
      { id: "message", label: "Message", icon: Send, tone: "primary" },
      { id: "remove", label: "Remove vendor", icon: Trash2, tone: "danger" },
    ],
    hasDocuments: false,
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
    // Studio CX-RC6 (Tour and Communication): the first section is the Tour itself (Tour and
    // Prospect fact cards); Communication follows. Its route id stays `overview`.
    ownGroups: [{ label: "Tour", ids: [{ id: "overview", label: "Tour" }] }],
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
    // Studio plan services-vendors-1004: BOOKING: Booking · Guest, LINKED: Payments, then
    // Communication (the shared trio). The Booking section keeps the `overview` id.
    ownGroups: [
      { label: "Booking", ids: [
        { id: "overview", label: "Booking" },
        { id: "guest", label: "Guest" },
      ] },
      { label: "Linked", ids: [{ id: "payments", label: "Payments" }] },
    ],
    // Message is the filled primary (there is no check-in-details action to lead with); Edit is
    // dropped by the page for a channel stay, which only the channel can change.
    headerActions: [
      { id: "message", label: "Message", icon: Mail, tone: "primary" },
      { id: "edit", label: "Edit", icon: Pencil },
    ],
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      return (recordId, tab) => bookingRecordHref(basePath, recordId, tab as BookingDetailTabId);
    },
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
    // VD53 — Receipt opens the print-styled receipt route (never a Stripe
    // redirect); Refund (VD52) is offered only on a refundable payment —
    // `VendorPayoutRecordPage` filters it out itself when the caller passes
    // no `onRefund`, so a terminal/failed payout never shows a dead action.
    headerActions: [
      { id: "receipt", label: "Receipt", icon: Download },
      { id: "refund", label: "Refund", icon: RefreshCw, tone: "danger" },
    ],
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
  const hidden = new Set(ctx.hiddenSections ?? []);
  const groups: RecordSectionGroup[] = def.ownGroups
    .map((group) => ({
      label: group.label,
      items: group.ids.filter(({ id }) => !hidden.has(id)).map(({ id, label }) => ({
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

  const headerActions = orderHeaderActions(
    (activeSectionId && def.sectionActions?.[activeSectionId]) || def.headerActions,
  );

  return {
    groups,
    headerActions,
  };
}

/** The ids the registry always owns — a caller passing one of these itself is a bug. */
export const RECORD_TRIO_IDS = ["communication", "documents", "activity"] as const;
