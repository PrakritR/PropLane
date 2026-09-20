import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Calendar,
  Camera,
  CheckCircle2,
  CreditCard,
  Download,
  FileSignature,
  Lock,
  Mail,
  Pencil,
  RefreshCw,
  Send,
  Share2,
  Trash2,
  UserMinus,
  UserPlus,
  Eye,
  Copy,
  XCircle,
} from "lucide-react";
import {
  inspectionDetailHref,
  managerTaskDetailHref,
  paymentRecordDetailHref,
  propertyDetailHref,
  PROPERTY_DETAIL_TAB_LABELS,
  residentDetailHref,
  vendorDetailHref,
  type PaymentDirectionId,
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
  | "tour"
  | "booking"
  | "document";

export type ResidentRecordKind = "payment" | "lease" | "service" | "inspection" | "document";

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
  headerActions: RecordHeaderAction[];
  /** Id into `headerActions` rendered as the phone sticky primary button. */
  phonePrimary?: string;
  /** Sticky-button copy when it differs from the header action's tooltip ("Edit listing" vs "Edit"). */
  phonePrimaryLabel?: string;
};

/** Extra ids a kind's href builder needs beyond the record id itself — every field optional, sensibly defaulted. */
export type RecordSectionContext = {
  basePath?: string;
  /** property */
  stage?: string;
  /** resident */
  residentsTab?: string;
  /** payment / outgoing-payment */
  direction?: PaymentDirectionId;
  bucket?: string;
  /** inspection */
  inspectionKind?: "move-in" | "move-out";
  /** task */
  taskListTab?: string;
};

type OwnGroup = { label: string; ids: Array<{ id: string; label: string }> };

type KindDef = {
  basePathDefault: string;
  ownGroups: OwnGroup[];
  headerActions: RecordHeaderAction[];
  phonePrimary?: string;
  phonePrimaryLabel?: string;
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
      { label: "Property", ids: ["preview", "house-details", "move-in"].map((id) => ({ id, label: PROPERTY_DETAIL_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TAB_LABELS] })) },
      { label: "Leasing", ids: ["tours", "bookings", "application", "lease"].map((id) => ({ id, label: PROPERTY_DETAIL_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TAB_LABELS] })) },
      { label: "Operations", ids: ["requests", "promotion", "ai-info"].map((id) => ({ id, label: PROPERTY_DETAIL_TAB_LABELS[id as keyof typeof PROPERTY_DETAIL_TAB_LABELS] })) },
    ],
    headerActions: [
      { id: "view-public", label: "View public", icon: Eye },
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "share", label: "Share", icon: Share2 },
      { id: "copy", label: "Copy", icon: Copy },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    phonePrimary: "edit",
    phonePrimaryLabel: "Edit listing",
    hasDocuments: true,
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
    phonePrimary: "message",
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
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    phonePrimary: "record-payment",
    phonePrimaryLabel: "Record payment",
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
    phonePrimary: "pay-now",
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
    ownGroups: [{ label: "Lease", ids: [
      { id: "overview", label: "Overview" },
      { id: "terms", label: "Terms" },
      { id: "signatures", label: "Signatures" },
      { id: "amendments", label: "Amendments" },
      { id: "payments", label: "Payments" },
    ] }],
    headerActions: [
      { id: "send", label: "Send", icon: Send },
      { id: "amend", label: "Amend", icon: Pencil },
      { id: "download", label: "Download", icon: Download },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    phonePrimary: "send",
    phonePrimaryLabel: "Send for signature",
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => genericHref(ctx.basePath ?? "/portal", "leases"),
  },
  application: {
    basePathDefault: "/portal",
    ownGroups: [{ label: "Application", ids: [
      { id: "overview", label: "Overview" },
      { id: "applicants", label: "Applicants" },
      { id: "screening", label: "Screening" },
      { id: "decision", label: "Decision" },
    ] }],
    headerActions: [
      { id: "approve", label: "Approve", icon: CheckCircle2 },
      { id: "decline", label: "Decline", icon: XCircle, tone: "danger" },
      { id: "share", label: "Share", icon: Share2 },
      { id: "archive", label: "Archive", icon: Archive },
    ],
    phonePrimary: "approve",
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => genericHref(ctx.basePath ?? "/portal", "applications"),
  },
  inspection: {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Inspection", ids: [{ id: "overview", label: "Overview" }] },
      { label: "People", ids: [
        { id: "resident", label: "Resident" },
        { id: "vendor", label: "Vendor" },
      ] },
      { label: "Money", ids: [{ id: "payments", label: "Payments" }] },
    ],
    headerActions: [
      { id: "request-photos", label: "Request photos", icon: Camera },
      { id: "download-report", label: "Download report", icon: Download },
      { id: "lock", label: "Lock", icon: Lock },
    ],
    phonePrimary: "request-photos",
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const kind = ctx.inspectionKind ?? "move-in";
      return (recordId, tab) => inspectionDetailHref(basePath, kind, recordId, tab as never);
    },
  },
  service: {
    basePathDefault: "/portal",
    ownGroups: [{ label: "Service", ids: [
      { id: "overview", label: "Overview" },
      { id: "vendor-bids", label: "Vendor & bids" },
      { id: "schedule", label: "Schedule" },
      { id: "invoice", label: "Invoice" },
    ] }],
    headerActions: [
      { id: "assign-vendor", label: "Assign vendor", icon: UserPlus },
      { id: "schedule", label: "Schedule", icon: Calendar },
      { id: "close", label: "Close", icon: CheckCircle2 },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    phonePrimary: "assign-vendor",
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => genericHref(ctx.basePath ?? "/portal", "services/work-orders"),
  },
  task: {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Task", ids: [{ id: "overview", label: "Overview" }] },
      { label: "Money", ids: [{ id: "payments", label: "Payments" }] },
      { label: "People", ids: [
        { id: "vendor", label: "Vendor" },
        { id: "resident", label: "Resident" },
      ] },
    ],
    headerActions: [
      { id: "mark-done", label: "Mark done", icon: CheckCircle2 },
      { id: "reassign", label: "Reassign", icon: RefreshCw },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    phonePrimary: "mark-done",
    phonePrimaryLabel: "Mark done",
    hasDocuments: false,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      const listTab = ctx.taskListTab ?? "in-progress";
      return (recordId, tab) => managerTaskDetailHref(basePath, listTab as never, recordId, tab as never);
    },
  },
  vendor: {
    basePathDefault: "/portal",
    ownGroups: [
      { label: "Vendor", ids: [
        { id: "overview", label: "Overview" },
        { id: "profile", label: "Profile" },
      ] },
      { label: "Work", ids: [
        { id: "jobs", label: "Jobs" },
        { id: "check-ins", label: "Check-ins" },
      ] },
    ],
    headerActions: [
      { id: "message", label: "Message", icon: Mail },
      { id: "invite", label: "Invite", icon: UserPlus },
      { id: "remove", label: "Remove", icon: UserMinus, tone: "danger" },
    ],
    phonePrimary: "message",
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => {
      const basePath = ctx.basePath ?? "/portal";
      return (recordId, tab) => vendorDetailHref(basePath, recordId, tab as never);
    },
  },
  tour: {
    basePathDefault: "/portal",
    ownGroups: [{ label: "Tour", ids: [
      { id: "overview", label: "Overview" },
      { id: "prospect", label: "Prospect" },
      { id: "slot", label: "Slot" },
      { id: "follow-up", label: "Follow-up" },
    ] }],
    headerActions: [
      { id: "confirm", label: "Confirm", icon: CheckCircle2 },
      { id: "reschedule", label: "Reschedule", icon: RefreshCw },
      { id: "decline", label: "Decline", icon: XCircle, tone: "danger" },
    ],
    phonePrimary: "confirm",
    hasDocuments: false,
    hasActivity: true,
    href: (ctx) => genericHref(ctx.basePath ?? "/portal", "tours"),
  },
  booking: {
    basePathDefault: "/portal",
    ownGroups: [{ label: "Booking", ids: [
      { id: "overview", label: "Overview" },
      { id: "guest", label: "Guest" },
      { id: "charges", label: "Charges" },
    ] }],
    headerActions: [
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "cancel", label: "Cancel", icon: XCircle, tone: "danger" },
    ],
    phonePrimary: "edit",
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
    phonePrimary: "download",
    hasDocuments: false,
    hasActivity: true,
    href: (ctx) => genericHref(ctx.basePath ?? "/portal", "documents"),
  },
};

const RESIDENT_DEFS: Record<ResidentRecordKind, KindDef> = {
  payment: {
    basePathDefault: "/resident",
    ownGroups: [{ label: "Payment", ids: [
      { id: "overview", label: "Overview" },
      { id: "receipt", label: "Receipt" },
    ] }],
    headerActions: [
      { id: "pay", label: "Pay", icon: CreditCard },
      { id: "download-receipt", label: "Download receipt", icon: Download },
    ],
    phonePrimary: "pay",
    hasDocuments: true,
    hasActivity: false,
    href: (ctx) => genericHref(ctx.basePath ?? "/resident", "payments"),
  },
  lease: {
    basePathDefault: "/resident",
    ownGroups: [{ label: "Lease", ids: [
      { id: "overview", label: "Overview" },
      { id: "terms", label: "Terms" },
      { id: "signatures", label: "Signatures" },
      { id: "payments", label: "Payments" },
    ] }],
    headerActions: [
      { id: "sign", label: "Sign", icon: FileSignature },
      { id: "download", label: "Download", icon: Download },
    ],
    phonePrimary: "sign",
    hasDocuments: true,
    hasActivity: false,
    href: (ctx) => genericHref(ctx.basePath ?? "/resident", "lease"),
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
    phonePrimary: "message",
    phonePrimaryLabel: "Message manager",
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => genericHref(ctx.basePath ?? "/resident", "services"),
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
    phonePrimary: "add-photos",
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
    phonePrimary: "download",
    hasDocuments: false,
    hasActivity: false,
    href: (ctx) => genericHref(ctx.basePath ?? "/resident", "documents"),
  },
};

const VENDOR_DEFS: Record<VendorRecordKind, KindDef> = {
  job: {
    basePathDefault: "/vendor",
    ownGroups: [{ label: "Job", ids: [
      { id: "overview", label: "Overview" },
      { id: "scope-photos", label: "Scope & photos" },
      { id: "schedule", label: "Schedule" },
      { id: "bid-invoice", label: "Bid / Invoice" },
    ] }],
    headerActions: [
      { id: "accept", label: "Accept", icon: CheckCircle2 },
      { id: "schedule", label: "Schedule", icon: Calendar },
      { id: "submit-invoice", label: "Submit invoice", icon: Send },
    ],
    phonePrimary: "accept",
    hasDocuments: true,
    hasActivity: true,
    href: (ctx) => genericHref(ctx.basePath ?? "/vendor", "work-orders"),
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
    phonePrimary: "submit",
    hasDocuments: true,
    hasActivity: false,
    href: (ctx) => genericHref(ctx.basePath ?? "/vendor", "invoices"),
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
    href: (ctx) => genericHref(ctx.basePath ?? "/vendor", "payouts"),
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

  const trioItems: RecordSectionItem[] = [
    { id: "communication", label: "Communication", href: (recordId: string) => hrefFor(recordId, "communication") },
  ];
  if (def.hasDocuments) {
    trioItems.push({ id: "documents", label: "Documents", href: (recordId: string) => hrefFor(recordId, "documents") });
  }
  if (def.hasActivity) {
    trioItems.push({ id: "activity", label: "Activity", href: (recordId: string) => hrefFor(recordId, "activity") });
  }
  // No group label: Communication/Documents/Activity read as universal record
  // chrome, not a labeled category the way "Money" or "People" are.
  groups.push({ label: "", items: trioItems });

  return {
    groups,
    headerActions: def.headerActions,
    phonePrimary: def.phonePrimary,
    phonePrimaryLabel: def.phonePrimaryLabel,
  };
}

/** The ids the registry always owns — a caller passing one of these itself is a bug. */
export const RECORD_TRIO_IDS = ["communication", "documents", "activity"] as const;
