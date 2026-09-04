/**
 * Portal UI types; table data is empty until backed by your API / database.
 */

import type { RentalWizardFormState } from "@/lib/rental-application/types";
import type { ResidentChargeMessage } from "@/lib/household-charges";
import type { ApplicationBackgroundCheckStatus } from "@/lib/application-background-check";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import type { ApplicationScreeningReport } from "@/lib/screening/types";

export const demoKpis = {
  applications: { pending: "0", approved: "0", rejected: "0" },
  leases: { managerReview: "0", adminReview: "0", withResident: "0", signed: "0" },
  payments: { pending: "0", overdue: "0", paid: "0" },
  workOrders: { open: "0", scheduled: "0", completed: "0" },
  managers: { current: "0", past: "0" },
  calendar: { today: "0", week: "0", month: "0", total: "0" },
} as const;

export type DemoOwnerAccountRow = {
  id: string;
  name: string;
  email: string;
  properties: string;
  active: boolean;
};

export const demoOwnerAccounts: DemoOwnerAccountRow[] = [];

export const demoOwnerPropertyCards: { name: string; units: string; access: string; manager: string }[] = [];

export type ManagerApplicationBucket = "pending" | "approved" | "rejected";

export type DemoApplicantRow = {
  id: string;
  name: string;
  property: string;
  stage: string;
  bucket: ManagerApplicationBucket;
  email?: string;
  detail: string;
  application?: RentalWizardFormState;
  /** Listing id from the rental application (for filtering). */
  propertyId?: string;
  /** Manager-selected final property placement. */
  assignedPropertyId?: string;
  /** Manager-selected final room placement. */
  assignedRoomChoice?: string;
  /** Rent locked for this tenant when placement / approval is finalized. */
  signedMonthlyRent?: number | null;
  /** Listing owner scope — who should receive this application in the portal. */
  managerUserId?: string | null;
  /** True when the manager (not the applicant) created or completed this application, e.g. via the Residents-tab Add flow — exempts it from the applicant-facing application fee. */
  manuallyAdded?: boolean;
  /** Move-in instructions set by the manager from the Residents tab. */
  moveInInstructions?: string;
  /** Background screening outcome shown to managers (automation fills this later). */
  backgroundCheckStatus?: ApplicationBackgroundCheckStatus;
  /** Vendor screening report (Certn) with manager-facing pros/cons summary. */
  screening?: ApplicationScreeningReport;
  /**
   * ISO timestamp set when the resident withdraws their own application. A
   * withdrawn application is a REVERSIBLE, non-destructive state — it leaves the
   * resident's active list but the manager keeps the record (screening, docs,
   * answers, bucket) intact. Never a hard delete. Absent/null = active.
   */
  withdrawnAt?: string | null;
  /** Public Axis application id when linked to a resident account. */
  axisId?: string;
  /** Linked resident auth user id when known. */
  residentUserId?: string | null;
  /** SHA-256 hex of the one-time resident account setup token (raw token is emailed once). */
  setupTokenHash?: string | null;
  /** ISO expiry for the resident account setup token. */
  setupTokenExpiresAt?: string | null;
  /** ISO timestamp when the one-time setup email was sent after the applicant started (not submitted). */
  startedSetupEmailSentAt?: string | null;
  /** ISO timestamp when the setup token was used to create/link a resident account. */
  setupTokenConsumedAt?: string | null;
  /** Checkr criminal background check (clear/consider) — run per-applicant on demand. */
  backgroundCheck?: ApplicationBackgroundCheck;
  /** Extra fields only present on manually-added residents. */
  manualResidentDetails?: {
    phone?: string;
    moveInDate?: string;
    moveOutDate?: string;
    monthlyUtilities?: number;
    moveInFee?: number;
    securityDeposit?: number;
    roomNumber?: string;
    leaseTerm?: string;
    notes?: string;
    /** ISO timestamp when the existing-resident portal welcome email was sent. */
    onboardingWelcomeSentAt?: string;
    /** Signed lease PDF uploaded by manager for off-platform leases. */
    signedLeaseFileName?: string;
    signedLeaseDataUrl?: string;
    signedLeaseUploadedAt?: string;
    /** Lease treated as executed off-platform; skips e-sign workflow. */
    externallySignedLease?: true;
  };
};

export const demoApplicantRows: DemoApplicantRow[] = [];

export const demoPaymentRows: { resident: string; unit: string; amount: string; due: string; status: string }[] = [];

export const demoWorkOrderRows: { id: string; unit: string; title: string; priority: string; status: string }[] = [];

export const demoInboxPreviewRows: {
  from: string;
  subject: string;
  preview: string;
  when: string;
  unread: string;
}[] = [];

export const demoAdminPropertyRows: { name: string; manager: string; units: string; status: string }[] = [];

export const demoManagerSubscriberRows: { name: string; org: string; portfolio: string; status: string; since: string }[] =
  [];

export const demoLeasePipelineRows: { resident: string; unit: string; stage: string; updated: string }[] = [];

export const demoResidentPropertyRows: { building: string; unit: string; manager: string; since: string }[] = [];

export const demoResidentLeaseRows: { document: string; status: string; updated: string }[] = [];

/** Manager Properties calendar filter rows (when no Supabase-backed list yet). */
export type ManagerHouseBucket = "pending" | "change" | "listed" | "unlisted" | "rejected";

export type DemoManagerHouseRow = {
  id: string;
  name: string;
  address: string;
  propertyType: string;
  roomCount: number;
  bathCount: number;
  appFee: string;
  bucket: ManagerHouseBucket;
  detail: string;
};

export const demoManagerHouseRows: DemoManagerHouseRow[] = [];

export type ManagerPaymentBucket = "pending" | "overdue" | "paid";

export type ManagerPaymentDirection = "incoming" | "outgoing";

export type DemoManagerPaymentLedgerRow = {
  id: string;
  propertyId?: string;
  propertyName: string;
  roomNumber: string;
  /** Household charge kind when the row is backed by a charge (e.g. stay_total). */
  chargeKind?: string;
  residentName: string;
  residentEmail?: string;
  chargeTitle: string;
  lineAmount: string;
  amountPaid: string;
  balanceDue: string;
  dueDate: string;
  /** Parsed due-date epoch ms for ordering (null when the due label isn't a real date, e.g. "Before move-in"). */
  dueDateSortMs?: number | null;
  bucket: ManagerPaymentBucket;
  statusLabel: string;
  notes: string;
  householdChargeId?: string;
  cancelledReminders?: Array<"7d" | "5d" | "3d" | "12h" | "overdue_daily">;
  manualPaymentChannel?: "zelle" | "venmo";
  manualPaymentReportedAt?: string;
  paymentReference?: string;
  zelleContactSnapshot?: string;
  venmoContactSnapshot?: string;
  residentChargeMessages?: ResidentChargeMessage[];
};

export type DemoManagerOutgoingPaymentRow = {
  id: string;
  propertyId?: string;
  propertyName: string;
  categoryLabel: string;
  payeeLabel: string;
  chargeTitle: string;
  amountLabel: string;
  dueDate: string;
  /** Parsed due-date epoch ms for ordering (null when the source has no date). */
  dueDateSortMs?: number | null;
  bucket: ManagerPaymentBucket;
  statusLabel: string;
  expenseEntryId?: string;
  workOrderId?: string;
  /** When true the row came from a logged expense (not a pending vendor payout). */
  fromExpense?: boolean;
  /**
   * @deprecated Never set on a resident payment: PropLane absorbs Stripe's
   * processing cost and takes no platform fee, so the manager has no payment
   * cost row to report (see `manager-outgoing-payments.ts`).
   */
  fromAxisFee?: boolean;
  vendorId?: string;
  amountCents?: number;
  vendorPaymentMethods?: ("zelle" | "venmo" | "ach")[];
  zelleContactSnapshot?: string;
  venmoContactSnapshot?: string;
  achAvailable?: boolean;
  paidViaChannel?: "zelle" | "venmo" | "ach";
  paidAtLabel?: string;
};

export const demoManagerPaymentLedgerRows: DemoManagerPaymentLedgerRow[] = [];

export type ManagerWorkOrderBucket = "open" | "scheduled" | "completed";

export type DemoManagerWorkOrderRow = {
  id: string;
  /** Stable human handle, unique within the owning manager (for example WO-1042). */
  reference?: string;
  propertyName: string;
  unit: string;
  title: string;
  priority: string;
  status: string;
  bucket: ManagerWorkOrderBucket;
  description: string;
  scheduled: string;
  cost: string;
  /** Resident preference for when maintenance may arrive (e.g. "after 5pm" or "anytime"). */
  preferredArrival?: string;
  /** Resident answer to "can the repair person enter if you're not home?" */
  entryPermission?: "allowed" | "call_first" | "resident_present";
  entryNotes?: string;
  /** Full property address, snapshotted at submission time for manager/vendor display. */
  propertyAddress?: string;
  scheduledAtIso?: string;
  /** Google Calendar event id after PropPlane sync. */
  googleCalendarEventId?: string;
  residentName?: string;
  residentEmail?: string;
  propertyId?: string;
  assignedPropertyId?: string;
  assignedRoomChoice?: string;
  managerUserId?: string | null;
  photoDataUrls?: string[];
  vendorId?: string;
  vendorName?: string;
  /** Populated once the vendor signs up and links to manager_vendor_records. */
  vendorUserId?: string | null;
  vendorAssignedAt?: string;
  /** Manager handles the work themselves — no vendor assigned, no vendor email sent. */
  selfAssigned?: boolean;
  category?: "cleaning" | "plumbing" | "mold" | "electrical" | "hvac" | "general" | "appliance" | "access";
  vendorCostCents?: number;
  /** ISO timestamp when the vendor set labor cost via set-vendor-price (locks manager edits). */
  vendorPriceSetAt?: string;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
  completedAt?: string;
  expenseEntryIds?: string[];
  /** Logged by manager (not submitted by resident). */
  managerInitiated?: boolean;
  /** Manager has invited the assigned vendor to submit a cost/time bid (see work_order_bids). */
  biddingOpen?: boolean;
  biddingOpenedAt?: string;
  biddingResolvedAt?: string;
  /** Vendor tapped "Mark done" (work-orders/mark-done route) and is awaiting manager
   * approve + pay, or the manager has since approved + paid (bookkeeping status only —
   * no real money movement; see work-orders/approve-pay route). */
  automationStatus?: "vendor_marked_done" | "paid";
  vendorMarkedDoneAt?: string;
  vendorMarkedDoneNote?: string;
  paidAt?: string;
  /** How the manager paid the vendor (bookkeeping + payout routing). */
  vendorPaymentChannel?: "zelle" | "venmo" | "ach";
  vendorZelleContactSnapshot?: string;
  vendorVenmoContactSnapshot?: string;
  /** WO- memo code for Zelle/Venmo vendor payouts. */
  paymentReference?: string;
  /** Gmail message id when auto-marked from vendor Gmail sync. */
  paidViaGmailMessageId?: string;
  /** ISO timestamp of the resident's last manager reminder for this pending request. */
  residentReminderSentAt?: string;
};

export const demoManagerWorkOrderRowsFull: DemoManagerWorkOrderRow[] = [];

export type ManagerLeaseBucket = "manager" | "resident" | "signed";

/** UI tabs on the manager Leases page (includes fully signed leases separate from countersign). */
export type ManagerLeaseTab = ManagerLeaseBucket | "completed";

export type DemoManagerLeaseDraftRow = {
  id: string;
  resident: string;
  unit: string;
  stageLabel: string;
  updated: string;
  bucket: ManagerLeaseBucket;
  pdfVersion: string;
  notes: string;
};

export const demoManagerLeaseDraftRows: DemoManagerLeaseDraftRow[] = [];

export const demoResidentLeaseHub = {
  moveIn: "—",
  termLabel: "—",
  deposit: "—",
  paymentAtSigning: "—",
  pdfName: "—",
} as const;

export const demoResidentLeaseVersions: { id: string; label: string; note: string }[] = [];

export const demoResidentLeaseChecklist: { id: string; label: string; done: boolean }[] = [];

export type ResidentWorkBucket = "open" | "scheduled" | "completed";

export type DemoResidentWorkOrderRow = {
  id: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  bucket: ResidentWorkBucket;
  description: string;
};

export const demoResidentWorkOrderRows: DemoResidentWorkOrderRow[] = [];

export type DemoResidentChargeRow = {
  id: string;
  title: string;
  amountDue: string;
  balance: string;
  dueDate: string;
  statusLabel: string;
};

export const demoResidentChargeRows: DemoResidentChargeRow[] = [];

export type DemoResidentInboxThread = {
  id: string;
  from: string;
  email: string;
  subject: string;
  preview: string;
  when: string;
  unread: boolean;
  body: string;
};

export const demoResidentInboxThreads: DemoResidentInboxThread[] = [];

export type DemoManagerInboxThreadSeed = {
  id: string;
  folder: "inbox" | "sent" | "trash";
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string;
  time: string;
  unread: boolean;
};

export const demoManagerInboxThreads: DemoManagerInboxThreadSeed[] = [];

export function demoManagerInboxUnopenedCount(): number {
  return demoManagerInboxThreads.filter((t) => t.folder === "inbox" && t.unread).length;
}
