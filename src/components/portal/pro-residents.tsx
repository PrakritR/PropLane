"use client";

import { managerApplicationsReadSucceeded } from "@/lib/manager-applications-storage";
import { track } from "@/lib/analytics/track-client";
import { leasePipelineReadSucceeded } from "@/lib/lease-pipeline-storage";
import { isActiveWorkspaceId, workspaceContainsProperty } from "@/lib/workspaces/selection";

import { Bell, CheckCircle2, Download, XCircle, Mail, Settings as SettingsIcon, Pencil, Send, ScrollText, Upload } from "lucide-react";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { ResidentRecordMoveInSection } from "@/components/portal/move-in-forms/resident-record-move-in-section";
import { useResidentMoveInNeedsYou } from "@/components/portal/move-in-forms/use-resident-move-in-needs";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { cn } from "@/lib/utils";
import { useCommunicationSurfaceChrome } from "@/hooks/use-communication-surface-chrome";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PortalDetailDestinationNav } from "@/components/portal/portal-detail-destination-nav";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import {
  ResidentOverviewPanel,
  type ResidentOverviewServiceItem,
} from "@/components/portal/pro-resident-overview-panel";
import { PortalPageChrome, PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import {Input, Textarea, Select} from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  Modal,
  ModalFooter,
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_FULL_ROW_CLASS,
  PORTAL_MODAL_FORM_GRID_CLASS,
} from "@/components/ui/modal";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { ApproveApplicationDialog } from "@/components/portal/approve-application-dialog";
import { LeaseSendSheet } from "@/components/portal/lease-send-sheet";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { UploadForResidentModal } from "@/components/portal/upload-for-resident-modal";
import { createChargesForExecutedLease } from "@/lib/lease-signing-charges.client";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import {
  ManagerPortalPageShell,
} from "@/components/portal/portal-metrics";
import {
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";
import { useScheduledPaymentMessages } from "@/components/portal/payment-schedule-ui";
import { formatFriendlyReminderSchedule } from "@/lib/payment-reminder-presets";
import { togglePortalListClusterSelection } from "@/components/portal/application-household-list";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import type { ManagerPaymentBucket } from "@/data/demo-portal";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import {
  RESIDENT_DIRECTORY_TABS,
  RESIDENT_DIRECTORY_TAB_LABELS,
  RESIDENT_DETAIL_TABS_BY_STAGE,
  PAYMENT_BUCKETS,
  managerResidentItemDetailHref,
  managerResidentTourDetailHref,
  managerResidentTourListHref,
  residentDetailHref,
  residentListHref,
  residentPaymentDetailHref,
  residentRecordMoveInHref,
  parseResidentDetailTab,
  parseResidentRecordMoveInTab,
  parseResidentsTab,
  type ResidentDetailTabId,
  type ResidentMoveInTabId,
  type ResidentsTabId,
  type ManagerTourBucketId,
} from "@/lib/portal-detail-routes";
import {
  RESIDENT_DETAIL_APPLICATION_BUCKET_TABS,
  RESIDENT_DETAIL_BACKGROUND_CHECK_BUCKET_TABS,
  RESIDENT_DETAIL_LEASE_PIPELINE_TABS,
  residentApplicationStatusBucket,
  residentBackgroundCheckStatusBucket,
  type ResidentRecordStatusBucketId,
} from "@/lib/resident-detail-subsection-tabs";
import { ResidentDetailCommandToolbar } from "@/components/portal/resident-detail-subsection-chrome";
import {
  ProPortalSettingsModal,
  type ManagerPortalSettingsTab,
} from "@/components/portal/pro-portal-settings-modal";
import {
  getSettingsEntryPoint,
  getSettingsEntryPointForTab,
  settingsDialogTitlePrefix,
} from "@/components/portal/settings-entry-points";
import { PortalServiceRecordRow, PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ResidentInviteClaimsPanel } from "@/components/portal/resident-invite-claims-panel";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PortalRecordActions, PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { appendManagerResidentActivityLog } from "@/lib/manager-resident-activity-log";
import { ManagerResidentApplicationFactCards } from "@/components/portal/manager-resident-application-fact-cards";
import { ManagerResidentBackgroundCheckPanel } from "@/components/portal/manager-resident-background-check-panel";
import { uploadManagerDocumentForResident } from "@/lib/manager-resident-document-upload";
import { DOCUMENT_CATEGORY_LABELS, type ManagerDocumentDTO } from "@/lib/documents/manager-documents";
import { triggerDocumentDownload } from "@/components/portal/resident-other-documents";
import { formatPortalListDate } from "@/lib/portal-display-dates";
import {
  emptyResidentEditRecord,
  residentEditApplicationFacts,
  residentEditChargesFromHousehold,
  residentEditLeaseDocument,
  residentEditLeaseStatusText,
  residentEditSignersFromLease,
  type ResidentEditDocument,
  type ResidentEditRecord,
} from "@/lib/resident-edit-record";
import { ApplicationDocumentPreview, runApplicationPdfDownload } from "@/components/portal/pro-applications";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { MoreHorizontal } from "lucide-react";
import type { RecordHeaderAction } from "@/lib/portals/record-sections";
import { ManagerResidentsGroupedTable } from "@/components/portal/pro-residents-grouped-table";
import { ManagerResidentToursPanel } from "@/components/portal/pro-resident-tours-panel";
import { ManagerResidentSectionToolbar } from "@/components/portal/manager-resident-section-toolbar";
import {
  ManagerResidentUploadModal,
  type ResidentUploadDocKind,
} from "@/components/portal/manager-resident-upload-modal";
import { LeaseSignersCard } from "@/components/portal/lease-signers-card";
import {
  ManagerResidentDocumentsPanel,
  type ManagerResidentDocTabId,
} from "@/components/portal/manager-resident-documents-panel";
import { buildResidentListClustersByMode } from "@/lib/manager-resident-list-grouping";
import { residentRowSlotFact } from "@/lib/manager-resident-list";
import {
  PORTAL_LIST_GROUP_MODE_LABELS,
  portalListGroupModeActiveCount,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import {
  DEV_RESIDENT_LIST_FIXTURES,
  shouldShowDevResidentListFixtures,
} from "@/lib/dev/resident-list-fixtures";
import {
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";
import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";
import { LeaseGenerateModal } from "@/components/portal/lease-generate-modal";
import { LeaseSigningModal } from "@/components/portal/lease-signing-modal";
import { ManagerPipelineLeaseEditModal } from "@/components/portal/pro-pipeline-lease-edit-modal";
import { AddResidentWizard } from "@/components/portal/resident-wizard";
import {
  ALSO_CREATE_IDS,
  MANAGER_APPLICATION_TEXT_KEYS,
  emptyAddPersonForm,
  type AddPersonForm,
} from "@/components/portal/resident-wizard/state";
import {
  resolveResidentEditStage,
  snapshotResidentEditBaseline,
  type ResidentEditBaseline,
  type ResidentEditStage,
} from "@/lib/resident-edit-stage";
import { mergeParsedFields } from "@/lib/resident-document-import/onboard-draft";
import { mapParsedFieldsToAddResidentForm } from "@/lib/resident-document-import/apply-parsed-to-add-resident";
import {
  resolveResidentOnboardingStage,
  type ResidentLeaseFiling,
} from "@/lib/resident-onboarding/resolve-onboarding-stage";
import {
  buildResidentLifecycle,
  residentHeaderStageLine,
  type ResidentLifecycleInput,
} from "@/lib/manager-resident-lifecycle";
import {
  parsedFieldsToRecord,
  parseResidentDocumentPdfClient,
  readDataUrlFromFile,
} from "@/lib/resident-document-import.client";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import {
  HOUSEHOLD_CHARGES_EVENT,
  HOUSEHOLD_CHARGES_SESSION_KEY,
  compareDueDateMs,
  householdChargeToLedgerRow,
  publicChargeIdForUrl,
  readChargesForManagerResident,
  recordApprovedApplicationCharges,
  removeAllApplicationCharges,
  removeResidentHouseholdPaymentData,
  syncHouseholdChargesFromServer,
  type HouseholdCharge,
} from "@/lib/household-charges";
import {
  appendManagerApplicationRow,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
  upsertApplicationRowToServerAwait,
  writeManagerApplicationRows,
  deleteManagerApplicationFromServer,
  MANAGER_APPLICATIONS_EVENT,
  normalizeApplicationAxisId,
} from "@/lib/manager-applications-storage";
import {
  applicationVisibleToPortalUser,
  buildManagerPropertyFilterOptions,
  collectLinkedPropertyIds,
  collectLinkedPropertyIdsForModule,
  MANAGER_PORTFOLIO_REFRESH_EVENTS,
} from "@/lib/manager-portfolio-access";
import {
  isPreviousResidentDirectoryRow,
  isResidentDirectoryRow,
  residentDirectoryStage,
  type ResidentDirectoryStage,
} from "@/lib/current-resident";
import { getPropertyById, getBundleOptionsForProperty, isEntireHomeProperty, isPropertyRentedByRoom, getRoomChoiceLabel, LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { computeLeaseEndDate, shouldAutoComputeLeaseEnd } from "@/lib/rental-application/lease-dates";
import { resolveManualResidentAssignment, resolveManualResidentPlacementValues } from "@/lib/rental-application/placement-values";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  isResidentMonthToMonthLease,
  listingLeaseTermToResidentValue,
  RESIDENT_LEASE_TERM_CUSTOM,
  residentLeaseTermOptionsForProperty,
  residentLeaseTermSelectValue,
  residentLeaseTermToApplicationFields,
  shouldUseResidentLeaseCustomMode,
} from "@/lib/resident-manual-lease-terms";
import { buildLeaseReadyForResidentMessage } from "@/lib/resident-portal-login-copy";

import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  appendLeaseThreadMessage,
  deleteLeasePipelineRowsForResident,
  regenerateEditableLeasesForResident,
  managerSignLease,
  leasePipelineRowsForManagerResident,
  LEASE_PIPELINE_EVENT,
  confirmUploadedLeaseParseOnServer,
  UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE,
  ensureManagerReviewLeaseForApplication,
  executedLeaseIdentities,
  readLeasePipeline,
  residentCanViewLeaseRow,
  syncLeasePipelineFromApplications,
  syncLeasePipelineFromServer,
  runLeaseDownload,
  hasBothLeaseSignatures,
  leaseAwaitingManagerCountersign,
  countLeaseListTabs,
  leaseRowMatchesListTab,
  type LeaseListTabId,
  type LeasePipelineRow,} from "@/lib/lease-pipeline-storage";
import { retryUploadedLeaseParse } from "@/lib/uploaded-lease-parse.client";
import { UploadedLeaseReviewModal } from "@/components/portal/uploaded-lease-review-modal";
import type { UploadedLeaseFieldKey } from "@/lib/uploaded-lease-extraction";
import {
  MANAGER_WORK_ORDERS_EVENT,
  deleteManagerWorkOrdersForResident,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  deleteManagerWorkOrderRow,
} from "@/lib/manager-work-orders-storage";
import {
  SERVICE_REQUESTS_EVENT,
  readServiceRequestsForResident,
  readServiceRequestsForManager,
  deleteServiceRequestsForResident,
  deleteServiceRequest,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import type { DemoApplicantRow, DemoManagerWorkOrderRow, ManagerApplicationBucket } from "@/data/demo-portal";
import { declineApplicationWithUndo, transitionApplicationBucket } from "@/lib/application-review";
import { useApplicationAutomation } from "@/hooks/use-application-automation";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import {
  APPLICATION_COMPLETION_REMINDER_SUBJECT,
  buildApplicationCompletionReminderBody,
} from "@/lib/application-completion-reminder-email";
import {
  applicationStageDisplayLabel,
  inProgressApplicationResumeUrl,
  isInProgressApplicationRow,
  shouldOfferApplicationCompletionReminder,
} from "@/lib/rental-application/in-progress-application";
import { buildApplicationGroups } from "@/lib/rental-application/application-groups";
import {
  invalidatePersistedInboxCache,
  loadPersistedInbox,
  MANAGER_INBOX_STORAGE_KEY,
  persistInbox,
  PORTAL_INBOX_CHANGED_EVENT,
  syncPersistedInboxFromServer,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { clearUploadedOwnLease } from "@/lib/resident-lease-upload";
import {
  RESIDENT_WELCOME_EMAIL_SUBJECT,
  buildResidentWelcomeEmailBody,
  residentAccountCreationUrl,
} from "@/lib/resident-welcome-email";
import {
  EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
  buildExistingResidentWelcomeEmailBody,
} from "@/lib/existing-resident-welcome-email";
import { fetchManagerReachabilityForWelcome } from "@/lib/manager-reachability-client";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { groupIdForRow, groupRowInputForRow } from "@/components/portal/application-group-section";
import { ManagerCosignerReadonlyReview } from "@/components/portal/pro-cosigner-readonly-review";
import { dedupeResidentsByEmail } from "@/lib/resident-directory-dedupe";
import { ApplicationHoldingFeeModal } from "@/components/portal/application-holding-fee-box";
import { useCosignerSubmissionsMap } from "@/hooks/use-cosigner-submissions-map";
import { signerAppIdsForCosignerLookup } from "@/lib/rental-application/application-list-grouping";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { ResidentApplicationEditor } from "@/components/portal/resident-application-editor";
import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";
import { ManagerResidentDetailInbox } from "@/components/portal/pro-resident-detail-inbox";
import {
  ManagerServiceRequestDetail,
  managerServiceRequestBucket,
  managerServiceRequestPricingSummary,
} from "@/components/portal/pro-service-request-detail";
import { ManagerAddPaymentModal } from "@/components/portal/pro-add-payment-modal";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { ManagerAddServiceModal } from "@/components/portal/pro-add-service-modal";
import type { ManagerServiceResidentOption } from "@/components/portal/pro-create-service-request-modal";
import {
  mergeApplicationLeaseDatesIntoResidentRow,
  persistResidentProfileEdit,
  syncResidentBillingAndLeases,
} from "@/lib/resident-lease-billing-sync";
import {
  shortTermNightlyRate,
  shortTermStayChargeTitle,
  shortTermStayNightCount,
} from "@/lib/short-term-stay-pricing";

const residentsSettingsEntry = getSettingsEntryPoint("residents");
const leasesSettingsEntry = getSettingsEntryPoint("leases");
const applicationsSettingsEntry = getSettingsEntryPoint("applications");
const paymentsSettingsEntry = getSettingsEntryPoint("payments");
const toursSettingsEntry = getSettingsEntryPoint("tours");

function residentRoomRentSuffix(
  room: { monthlyRent?: number; shortTermRent?: string },
  isShortTerm: boolean,
): string {
  if (isShortTerm) {
    const nightly = shortTermNightlyRate(room.shortTermRent);
    return nightly > 0 ? ` · $${nightly % 1 === 0 ? nightly : nightly.toFixed(2)}/night` : "";
  }
  return room.monthlyRent ? ` · $${room.monthlyRent}/mo` : "";
}

type ResidentUnifiedServicesBucket = "pending" | "scheduled" | "completed";

function residentUnifiedServiceBucketForRequest(
  req: ServiceRequest,
): ResidentUnifiedServicesBucket {
  const bucket = managerServiceRequestBucket(req.status);
  if (bucket === "pending") return "pending";
  if (bucket === "denied") return "completed";
  return "scheduled";
}

function residentUnifiedServiceBucketForWorkOrder(
  row: DemoManagerWorkOrderRow,
): ResidentUnifiedServicesBucket {
  if (row.bucket === "open") return "pending";
  if (row.bucket === "scheduled") return "scheduled";
  return "completed";
}

/**
 * Routed resident detail tab panel — flat content (no collapsible chevron stack).
 */
function ResidentDetailTabPanel({ children, fill }: { children: ReactNode; fill?: boolean }) {
  return (
    <div
      className={`pt-2 max-md:pt-1.5 ${fill ? "flex min-h-0 flex-1 flex-col space-y-0" : "space-y-3 max-md:space-y-2"}`}
      data-slot="resident-detail-tab-panel"
    >
      {children}
    </div>
  );
}

type ActiveResident = {
  id: string;
  name: string;
  email: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  /** Normalized household group id, so the list can cluster housemates together. */
  groupId: string;
  signedMonthlyRent: number | null;
  leaseStart: string;
  leaseEnd: string;
  axisId: string;
  manuallyAdded?: boolean;
  moveInInstructions?: string;
  /** Free-text note; portfolio import stamps "Imported from <file>." here (see `@/lib/portfolio-import/activity`). */
  detail?: string;
  manualResidentDetails?: NonNullable<import("@/data/demo-portal").DemoApplicantRow["manualResidentDetails"]>;
  isPrevious: boolean;
  stage: ResidentDirectoryStage;
  /** "Incomplete" / "Pending review" / "Approved" — what this person's application says today. */
  statusLabel: string;
  /** "Resident 2 of 2 · $800/mo" — populated when the resident is in a multi-occupancy room. */
  residentSlotFact?: string;
};

/**
 * What the server says a Delete would remove. The order is the order the confirm
 * dialog lists them, and "Services" covers both maintenance and add-on requests —
 * the product never says "work order".
 */
type ResidentDeleteCounts = {
  applications: number;
  leases: number;
  charges: number;
  services: number;
  inspections: number;
  documents: number;
  conversations: number;
  bookings: number;
  texts: number;
  paidCount: number;
  paidCents: number;
};

type ResidentDeletePreviewState = {
  loading: boolean;
  counts: ResidentDeleteCounts | null;
  /** Set when the count could not be read; Delete stays held rather than guessing. */
  error: string | null;
};

const EMPTY_RESIDENT_DELETE_PREVIEW: ResidentDeletePreviewState = {
  loading: false,
  counts: null,
  error: null,
};

function emptyResidentDeleteCounts(): ResidentDeleteCounts {
  return {
    applications: 0,
    leases: 0,
    charges: 0,
    services: 0,
    inspections: 0,
    documents: 0,
    conversations: 0,
    bookings: 0,
    texts: 0,
    paidCount: 0,
    paidCents: 0,
  };
}

function readResidentDeleteCounts(value: unknown): ResidentDeleteCounts {
  const source = (value ?? {}) as Record<string, unknown>;
  const counts = emptyResidentDeleteCounts();
  for (const key of Object.keys(counts) as (keyof ResidentDeleteCounts)[]) {
    const raw = source[key];
    counts[key] = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  }
  return counts;
}

function addResidentDeleteCounts(into: ResidentDeleteCounts, from: ResidentDeleteCounts): ResidentDeleteCounts {
  const total = { ...into };
  for (const key of Object.keys(total) as (keyof ResidentDeleteCounts)[]) total[key] += from[key];
  return total;
}

function formatUsdFromCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** "1 booking, 9 charges, 2 services" — only the buckets that actually had rows. */
function describeResidentDeleteCounts(counts: ResidentDeleteCounts): string {
  const parts: string[] = [];
  const bookings = counts.leases + counts.bookings;
  if (bookings) parts.push(`${bookings} booking${bookings === 1 ? "" : "s"}`);
  if (counts.charges) parts.push(`${counts.charges} charge${counts.charges === 1 ? "" : "s"}`);
  if (counts.services) parts.push(`${counts.services} service${counts.services === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function residentDeletePreviewRows(counts: ResidentDeleteCounts): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    {
      label: "Application · lease · charges",
      value: `${counts.applications} · ${counts.leases} · ${counts.charges}`,
    },
    { label: "Bookings", value: String(counts.leases + counts.bookings) },
    { label: "Messages and texts", value: String(counts.conversations + counts.texts) },
    {
      label: "Services · inspections · documents",
      value: `${counts.services} · ${counts.inspections} · ${counts.documents}`,
    },
    {
      label: "Paid payments",
      value: counts.paidCount ? `${counts.paidCount} · ${formatUsdFromCents(counts.paidCents)}` : "None",
    },
  ];
  return rows;
}

export function ManagerResidents({
  tabId: tabIdProp = "current",
  residentId: residentIdProp,
  detailTab: detailTabProp,
  paymentId: paymentIdProp,
  tourBucket: tourBucketProp = "pending",
  tourId: tourIdProp,
  serviceItemId: serviceItemIdProp,
  moveInTab: moveInTabProp,
  smsUiEnabled = false,
}: {
  tabId?: ResidentsTabId;
  residentId?: string;
  detailTab?: ResidentDetailTabId;
  paymentId?: string;
  tourBucket?: ManagerTourBucketId;
  tourId?: string;
  serviceItemId?: string;
  /** The Move in tab's sub-tab (`/move-in/{forms|placement|info|housemates|inspections}`). */
  moveInTab?: string;
  smsUiEnabled?: boolean;
}) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const searchParams = useSearchParams();
  const portalBase = usePaidPortalBasePath();
  const { userId, email: managerEmail, ready: authReady } = useManagerUserId();
  const applicationAutomation = useApplicationAutomation(userId);
  const {
    messages: scheduledPaymentMessages,
    settings: residentReminderSettings,
    reload: reloadResidentPaymentSchedule,
  } = useScheduledPaymentMessages({ includeHidden: true });
  const residentReminderScheduleSummary = useMemo(
    () => (residentReminderSettings ? formatFriendlyReminderSchedule(residentReminderSettings) : undefined),
    [residentReminderSettings],
  );
  const [hcTick, setHcTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [leaseTick, setLeaseTick] = useState(0);
  const [workOrderTick, setWorkOrderTick] = useState(0);
  const [srTick, setSrTick] = useState(0);
  const [inboxTick, setInboxTick] = useState(0);
  // Applications + lease pipeline must both settle before Potential/Current
  // counts are trusted — Current depends on executed leases, and an
  // applications-only redraw classifies every approved tenant as Potential
  // (PRP-458). Demo and unit tests skip the hold (static markup never runs
  // the sync effect).
  const [directoryError, setDirectoryError] = useState(false);
  const [directoryRetry, setDirectoryRetry] = useState(0);
  const [directoryLoadedFor, setDirectoryLoadedFor] = useState<string | null>(null);
  const [directoryRefreshing, setDirectoryRefreshing] = useState(false);
  const [directoryReady, setDirectorySourcesReady] = useState(
    () => isDemoModeActive() || process.env.NODE_ENV === "test",
  );
  const directorySourcesReady = directoryReady && (isDemoModeActive() || process.env.NODE_ENV === "test" || directoryLoadedFor === userId);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [residentSearch, setResidentSearch] = useState("");
  const RESIDENT_LIST_DEFAULT_GROUP_MODE: PortalListGroupMode = "house";
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(RESIDENT_LIST_DEFAULT_GROUP_MODE);
  const residentsTab = parseResidentsTab(tabIdProp);
  const [chargeBucket, setChargeBucket] = useState<ManagerPaymentBucket>("pending");
  const [residentPaymentSettingsOpen, setResidentPaymentSettingsOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [bulkDeletePreview, setBulkDeletePreview] = useState<ResidentDeletePreviewState>(
    EMPTY_RESIDENT_DELETE_PREVIEW,
  );
  const [prevSelectedId, setPrevSelectedId] = useState<string | null>(null);
  const [residentAccountEmails, setResidentAccountEmails] = useState<Set<string>>(new Set());
  const [importReviewLeaseId, setImportReviewLeaseId] = useState<string | null>(null);
  const [editResidentLeaseId, setEditResidentLeaseId] = useState<string | null>(null);
  const [activeResidentLeaseId, setActiveResidentLeaseId] = useState<string | null>(null);
  const [regenerateConfirmLeaseId, setRegenerateConfirmLeaseId] = useState<string | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);
  const [residentUploadOpen, setResidentUploadOpen] = useState(false);
  const [residentUploadKindPreset, setResidentUploadKindPreset] = useState<ResidentUploadDocKind>("other");
  const [residentDocsTick, setResidentDocsTick] = useState(0);
  const [residentUploadedDocs, setResidentUploadedDocs] = useState<ManagerDocumentDTO[]>([]);
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageScheduleLater, setMessageScheduleLater] = useState(false);
  const [messageScheduledRefresh, setMessageScheduledRefresh] = useState(0);
  const [leaseReminderBusy, setLeaseReminderBusy] = useState(false);
  const [leaseReminderPreview, setLeaseReminderPreview] = useState<{
    res: ActiveResident;
    leaseId: string;
    recipient: string;
    subject: string;
    body: string;
  } | null>(null);
  /** The one Send lease screen: a lease row, or an application whose Draft lease it creates. */
  /** Send application / Upload for resident, opened from the resident record header. */
  const [sendApplicationOpen, setSendApplicationOpen] = useState(false);
  const [uploadForResidentOpen, setUploadForResidentOpen] = useState(false);
  const [sendLeaseTarget, setSendLeaseTarget] = useState<{ leaseId?: string; applicationId?: string } | null>(null);
  const [signingLease, setSigningLease] = useState<LeasePipelineRow | null>(null);
  const [signingLeaseError, setSigningLeaseError] = useState<string | null>(null);
  const [welcomeEmailBusyForResident, setWelcomeEmailBusyForResident] = useState<string | null>(null);
  const [welcomePreviewFor, setWelcomePreviewFor] = useState<ActiveResident | null>(null);
  const [welcomePreviewContent, setWelcomePreviewContent] = useState("");
  const [approvePreviewRow, setApprovePreviewRow] = useState<DemoApplicantRow | null>(null);
  const [checkrScreeningRowId, setCheckrScreeningRowId] = useState<string | null>(null);
  const [holdingFeeRowId, setHoldingFeeRowId] = useState<string | null>(null);
  const [checkrScreeningShowPicker, setCheckrScreeningShowPicker] = useState(false);
  const [applicationReminderPreview, setApplicationReminderPreview] = useState<{
    row: DemoApplicantRow;
    to: string;
    subject: string;
    text: string;
  } | null>(null);
  const [applicationReminderPreviewBusyId, setApplicationReminderPreviewBusyId] = useState<string | null>(null);
  const [applicationReminderBusyId, setApplicationReminderBusyId] = useState<string | null>(null);

  // Services tab — unified add-on services + maintenance
  const [residentServicesBucket, setResidentServicesBucket] =
    useState<ResidentUnifiedServicesBucket>("pending");

  const activeDetailTab = parseResidentDetailTab(detailTabProp);
  // Inspections is a sub-tab of Move in: an old `/inspections` link opens Move in on it.
  const residentMoveInSubTab = parseResidentRecordMoveInTab(
    (detailTabProp as string | undefined) === "inspections" ? "inspections" : moveInTabProp,
  );
  const [applicationEditOpen, setApplicationEditOpen] = useState(false);
  const [applicationEditInitialStep, setApplicationEditInitialStep] = useState<number | undefined>(undefined);
  const [, setActivityLogTick] = useState(0);
  const [messageReminderForPayment, setMessageReminderForPayment] = useState(false);
  const [residentApplicationBucket, setResidentApplicationBucket] =
    useState<ResidentRecordStatusBucketId>("pending");
  const [residentBackgroundCheckBucket, setResidentBackgroundCheckBucket] =
    useState<ResidentRecordStatusBucketId>("incomplete");
  const [residentLeasePipelineTab, setResidentLeasePipelineTab] = useState<LeaseListTabId>("manager");
  const [residentDetailSettingsOpen, setResidentDetailSettingsOpen] = useState(false);
  const [residentDetailSettingsTab, setResidentDetailSettingsTab] =
    useState<ManagerPortalSettingsTab>("applications");
  const [addResidentPaymentOpen, setAddResidentPaymentOpen] = useState(false);
  const [addResidentServiceOpen, setAddResidentServiceOpen] = useState(false);
  const [embeddedPaymentFooterActions, setEmbeddedPaymentFooterActions] = useState<ReactNode>(null);
  const [embeddedPaymentBulkActions, setEmbeddedPaymentBulkActions] = useState<ReactNode>(null);
  const handleEmbeddedPaymentFooterActions = useCallback((actions: ReactNode | null) => {
    setEmbeddedPaymentFooterActions(actions);
  }, []);
  const handleEmbeddedPaymentBulkActions = useCallback((actions: ReactNode | null) => {
    setEmbeddedPaymentBulkActions(actions);
  }, []);
  // Add resident / prospect — the wizard owns its own form (resident-wizard/state.ts).
  const [addResidentOpen, setAddResidentOpen] = useState(false);

  // Edit resident
  const erSkipPricingFillRef = useRef(false);
  const [editResidentOpen, setEditResidentOpen] = useState(false);
  const [editResidentTargetId, setEditResidentTargetId] = useState<string | null>(null);
  const [editResidentForm, setEditResidentForm] = useState<AddPersonForm | null>(null);
  const [editResidentContext, setEditResidentContext] = useState<{
    stage: ResidentEditStage;
    baseline: ResidentEditBaseline;
    signedAtIso?: string | null;
    leaseId?: string | null;
  } | null>(null);
  const [editResidentRecord, setEditResidentRecord] = useState<ResidentEditRecord | null>(null);
  const [editResidentDocs, setEditResidentDocs] = useState<ResidentEditDocument[]>([]);
  const [erSaving, setErSaving] = useState(false);
  const [erName, setErName] = useState("");
  const [erEmail, setErEmail] = useState("");
  const [erPhone, setErPhone] = useState("");
  const [erPropertyId, setErPropertyId] = useState("");
  const [erRoomId, setErRoomId] = useState("");
  const [erBundleId, setErBundleId] = useState("");
  const [erLeaseTerm, setErLeaseTerm] = useState("");
  const [erLeaseTermCustomMode, setErLeaseTermCustomMode] = useState(false);
  const [erMoveInDate, setErMoveInDate] = useState("");
  const [erMoveOutDate, setErMoveOutDate] = useState("");
  const [erRent, setErRent] = useState("");
  const [erUtilities, setErUtilities] = useState("");
  const [erMoveInFee, setErMoveInFee] = useState("");
  const [erSecurityDeposit, setErSecurityDeposit] = useState("");
  const [erNotes, setErNotes] = useState("");

  useEffect(() => {
    const on = () => setHcTick((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, on);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, on);
    const onStorage = (e: StorageEvent) => {
      if (e.key === HOUSEHOLD_CHARGES_SESSION_KEY) on();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, on);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, on);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    const onLease = () => setLeaseTick((n) => n + 1);
    const onWorkOrder = () => setWorkOrderTick((n) => n + 1);
    const onSr = () => setSrTick((n) => n + 1);
    const onInbox = (evt?: Event) => {
      if (evt && evt.type === PORTAL_INBOX_CHANGED_EVENT) {
        const detail = (evt as CustomEvent<{ key?: string }>).detail;
        if (detail?.key && detail.key !== MANAGER_INBOX_STORAGE_KEY) return;
      }
      setInboxTick((n) => n + 1);
    };
    window.addEventListener(LEASE_PIPELINE_EVENT, onLease);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, onWorkOrder);
    window.addEventListener(SERVICE_REQUESTS_EVENT, onSr);
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, onInbox as EventListener);
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, onLease);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, onWorkOrder);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, onSr);
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, onInbox as EventListener);
    };
  }, []);

  useEffect(() => {
    const bump = () => setPropertyTick((n) => n + 1);
    for (const ev of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
      window.addEventListener(ev, bump);
    }
    return () => {
      for (const ev of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
        window.removeEventListener(ev, bump);
      }
    };
  }, []);

  useEffect(() => {
    if (!authReady || !userId) return;
    let cancelled = false;
    setDirectoryRefreshing(true);
    setDirectoryError(false);
    // Membership needs only properties, applications and leases. Ancillary
    // detail data may refresh independently without holding up this directory.
    void Promise.allSettled([
      syncManagerWorkOrdersFromServer(),
      syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY),
      syncHouseholdChargesFromServer(),
    ]).then(() => {
      if (cancelled) return;
      setInboxTick((n) => n + 1); setWorkOrderTick((n) => n + 1); setHcTick((n) => n + 1);
    });
    void Promise.all([
      syncPropertyPipelineFromServer({ userId }),
      syncManagerApplicationsFromServer({ managerUserId: userId }),
      syncLeasePipelineFromServer(userId),
    ]).then(([propertiesReady]) => {
      if (cancelled) return;
      if (!propertiesReady || !managerApplicationsReadSucceeded(userId) || !leasePipelineReadSucceeded(userId)) {
        setDirectoryError(true);
        return;
      }
      setPropertyTick((n) => n + 1);
      setLeaseTick((n) => n + 1);
      setDirectoryLoadedFor(userId);
      setDirectorySourcesReady(true);
    }).catch(() => { if (!cancelled) setDirectoryError(true); })
      .finally(() => { if (!cancelled) setDirectoryRefreshing(false); });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId, directoryRetry]);

  useEffect(() => {
    const emails = [
      ...new Set(
        readManagerApplicationRows()
          .filter(
            (row) =>
              isResidentDirectoryRow(row) &&
              row.email?.trim() &&
              applicationVisibleToPortalUser(row, userId, "residents"),
          )
          .map((row) => row.email!.trim().toLowerCase()),
      ),
    ];
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      if (!authReady || !userId) return;
      if (emails.length === 0) {
        setResidentAccountEmails(new Set());
        return;
      }
      // Demo sandbox: every demo resident already has an Axis account with
      // their portal set up — no "no Axis account yet" badges.
      if (isDemoModeActive()) {
        setResidentAccountEmails(new Set(emails));
        return;
      }
      const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails }) };
      const accountRes = await fetch("/api/manager/resident-account-emails", opts);
      if (cancelled) return;
      if (accountRes.ok) {
        const body = (await accountRes.json()) as { emails?: string[] };
        if (!cancelled) setResidentAccountEmails(new Set((body.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId, hcTick, propertyTick]);

  // Silently purge server-side orphaned records for deleted residents on mount.
  useEffect(() => {
    if (!authReady || !userId || isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/portal/purge-orphaned-records", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "current_only" }),
    })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { deleted?: Record<string, number>; purgedEmails?: string[] };
        const total = Object.values(body.deleted ?? {}).reduce((a, b) => a + b, 0);
        if (total === 0) return;
        await syncManagerApplicationsFromServer({ force: true, managerUserId: userId });
        void syncHouseholdChargesFromServer(true).then(() => { if (!cancelled) setHcTick((n) => n + 1); });
        void syncLeasePipelineFromServer(userId, { force: true }).then(() => { if (!cancelled) setLeaseTick((n) => n + 1); });
        void syncManagerWorkOrdersFromServer({ force: true }).then(() => { if (!cancelled) setWorkOrderTick((n) => n + 1); });
        void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true }).then(() => { if (!cancelled) setInboxTick((n) => n + 1); });
        const activeEmails = new Set(
          readManagerApplicationRows()
            .filter((row) => isResidentDirectoryRow(row) && !isPreviousResidentDirectoryRow(row))
            .map((r) => r.email?.trim().toLowerCase())
            .filter((e): e is string => Boolean(e)),
        );
        const purgedEmails = (body.purgedEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean);
        const purgedEmailSet = new Set(purgedEmails);
        for (const sr of readServiceRequestsForManager(userId)) {
          if (!activeEmails.has(sr.residentEmail.trim().toLowerCase())) {
            deleteServiceRequestsForResident(sr.residentEmail);
          }
        }
        for (const email of purgedEmailSet) {
          removeResidentHouseholdPaymentData(email);
          deleteManagerWorkOrdersForResident(email);
          deleteLeasePipelineRowsForResident(email, undefined, userId);
          deleteServiceRequestsForResident(email);
        }
        const inboxRows = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []);
        const filteredInbox = inboxRows.filter((thread) => {
          const participant = thread.email?.trim().toLowerCase() || "";
          return participant ? !purgedEmailSet.has(participant) : true;
        });
        if (filteredInbox.length !== inboxRows.length) {
          persistInbox(MANAGER_INBOX_STORAGE_KEY, filteredInbox);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authReady, userId]);

  // Whose lease is actually executed. Read once per pipeline change and reused
  // for the whole list — `residentDirectoryStage` needs the answer for every
  // row, and re-reading the pipeline per resident would be the same scan N times.
  const executedLeaseKeys = useMemo(() => {
    void leaseTick;
    return executedLeaseIdentities(userId);
  }, [leaseTick, userId]);

  const loadedDirectoryRows = useMemo<ActiveResident[]>(() => {
    void hcTick;
    // `propertyTick` is a cache-invalidation signal, not a value read here:
    // `applicationVisibleToPortalUser` consults the module-level property
    // pipeline cache, which React cannot see. Re-filter once that cache
    // hydrates so linked-property rows appear without a manual refresh.
    void propertyTick;
    // Hold the directory until applications + leases have both settled so an
    // applications-only event cannot publish Potential counts that flip to
    // Current a moment later (PRP-458).
    if (!directorySourcesReady) {
      if (shouldShowDevResidentListFixtures()) {
        return DEV_RESIDENT_LIST_FIXTURES.map((row) => ({
          ...row,
          stage: (row.isPrevious ? "past" : "current") as ResidentDirectoryStage,
          statusLabel: "",
        }));
      }
      return [];
    }
    const built = readManagerApplicationRows()
      .filter((row) => isResidentDirectoryRow(row) && applicationVisibleToPortalUser(row, userId, "residents") && (row.smsLeadWorkspaceId ? isActiveWorkspaceId(row.smsLeadWorkspaceId) : workspaceContainsProperty(row.assignedPropertyId || row.propertyId || row.application?.propertyId)))
      .map((row) => {
        const propId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || "";
        const prop = propId ? getPropertyById(propId) : null;
        const roomLabel =
          row.manualResidentDetails?.roomNumber?.trim() ||
          getRoomChoiceLabel(row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "").split(" · ")[0]?.trim() ||
          "";
        const propertyLabel = (prop?.buildingName?.trim() || prop?.title?.trim()?.replace(/\s*·\s*\d+\s*rooms?\s*$/i, "") || row.property || "").trim();
        const leaseStart = (row.manualResidentDetails?.moveInDate?.trim() || row.application?.leaseStart?.trim() || "");
        const leaseEnd = (row.manualResidentDetails?.moveOutDate?.trim() || row.application?.leaseEnd?.trim() || "");
        const axisId = normalizeApplicationAxisId(row.id);
        const leaseExecuted =
          executedLeaseKeys.axisIds.has(axisId) ||
          Boolean(row.email?.trim() && executedLeaseKeys.emails.has(row.email.trim().toLowerCase()));
        const stage = residentDirectoryStage(row, { leaseExecuted });
        return {
          id: row.id,
          // An unfinished application often has no name yet — every other
          // display site falls back to the address rather than printing a
          // blank row, and this list is now one of them.
          name: row.name?.trim() || (row.email ?? "").trim() || "Applicant",
          email: (row.email ?? "").trim(),
          propertyId: propId,
          propertyLabel,
          roomLabel,
          groupId: groupIdForRow(row).trim().toUpperCase(),
          signedMonthlyRent: row.signedMonthlyRent ?? null,
          leaseStart,
          leaseEnd,
          axisId,
          manuallyAdded: row.manuallyAdded,
          moveInInstructions: row.moveInInstructions,
          detail: row.detail,
          manualResidentDetails: row.manualResidentDetails,
          isPrevious: isPreviousResidentDirectoryRow(row),
          stage,
          statusLabel: applicationStageDisplayLabel(row),
          residentSlotFact: residentRowSlotFact(row),
        };
      });
    if (built.length === 0 && shouldShowDevResidentListFixtures()) {
      return DEV_RESIDENT_LIST_FIXTURES.map((row) => ({
        ...row,
        stage: (row.isPrevious ? "past" : "current") as ResidentDirectoryStage,
        statusLabel: "",
        residentSlotFact: undefined,
      }));
    }
    return built;
  }, [userId, hcTick, propertyTick, executedLeaseKeys, directorySourcesReady]);

  const [directorySnapshot, setDirectorySnapshot] = useState<{ viewer: string | null; rows: ActiveResident[] } | null>(null);
  useEffect(() => {
    if (directorySourcesReady && !directoryRefreshing && !directoryError) setDirectorySnapshot({ viewer: userId, rows: loadedDirectoryRows });
  }, [directorySourcesReady, directoryRefreshing, directoryError, userId, loadedDirectoryRows]);
  const residentDirectoryRows = directorySourcesReady && (directoryRefreshing || directoryError) && directorySnapshot?.viewer === userId
    ? directorySnapshot.rows : loadedDirectoryRows;

  const residents = useMemo(
    () => dedupeResidentsByEmail(residentDirectoryRows),
    [residentDirectoryRows],
  );

  const propertyOptions = useMemo(() => {
    void propertyTick;
    // Same catalog as Leases / Payments — workspace membership is authoritative
    // when the local extra-listings cache is empty, so Add resident can still
    // place someone in a house that already shows on Properties.
    const labelById = new Map(
      buildManagerPropertyFilterOptions(userId).map((option) => [option.id, option.label]),
    );
    for (const r of residents) {
      if (r.propertyId && !labelById.has(r.propertyId)) {
        labelById.set(r.propertyId, r.propertyLabel || r.propertyId);
      }
    }
    return [...labelById.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [residents, userId, propertyTick]);

  const erRoomOptions = useMemo(() => {
    void propertyTick;
    if (!erPropertyId) return [];
    const listing = getPropertyById(erPropertyId);
    if (!listing?.listingSubmission) return [];
    const sub = normalizeManagerListingSubmissionV1(listing.listingSubmission);
    return sub.rooms.map((r) => ({
      id: r.id,
      name: r.name || r.id,
      monthlyRent: r.monthlyRent,
      shortTermRent: r.shortTermRent,
    }));
  }, [erPropertyId, propertyTick]);

  const erLeaseTermOptions = useMemo(
    () => residentLeaseTermOptionsForProperty(erPropertyId),
    [erPropertyId, propertyTick],
  );
  const erLeaseTermPresetValues = useMemo(
    () => erLeaseTermOptions.map((o) => o.value),
    [erLeaseTermOptions],
  );

  const erManualLeaseFields = useMemo(
    () => residentLeaseTermToApplicationFields(erLeaseTerm, erLeaseTermCustomMode, erPropertyId),
    [erLeaseTerm, erLeaseTermCustomMode, erPropertyId],
  );
  const erIsShortTermStay = erManualLeaseFields.rentalType === "short_term";
  const erIsAirbnbStay = erManualLeaseFields.rentalType === "airbnb";

  const erRentedByRoom = useMemo(
    () => Boolean(erPropertyId.trim() && isPropertyRentedByRoom(erPropertyId)),
    [erPropertyId, propertyTick],
  );
  const erEntireHome = useMemo(
    () => Boolean(erPropertyId.trim() && isEntireHomeProperty(erPropertyId)),
    [erPropertyId, propertyTick],
  );
  const erBundleOptions = useMemo(
    () =>
      erPropertyId.trim()
        ? getBundleOptionsForProperty(erPropertyId, { rentalType: erIsShortTermStay ? "short_term" : "standard" })
        : [],
    [erPropertyId, erIsShortTermStay, propertyTick],
  );
  const erShowBundleSelect = erBundleOptions.length > 0;
  const erShowRoomSelect = erRentedByRoom && !erBundleId.trim() && erRoomOptions.length > 0;
  const erShowRoomSetupNote = erRentedByRoom && !erBundleId.trim() && erRoomOptions.length === 0;
  const erShowWholeUnitPlacementNote =
    Boolean(erPropertyId.trim()) && !erRentedByRoom && !erShowBundleSelect;

  const erStayPreview = useMemo(() => {
    if (!erIsShortTermStay) return null;
    const nights = shortTermStayNightCount(erMoveInDate, erMoveOutDate);
    const nightly = shortTermNightlyRate(erRent);
    if (!nights || !nightly) return null;
    return shortTermStayChargeTitle(nights, nightly);
  }, [erIsShortTermStay, erMoveInDate, erMoveOutDate, erRent]);

  useEffect(() => {
    if (erIsShortTermStay) setErUtilities("0");
    if (erIsAirbnbStay) {
      setErRent("0");
      setErUtilities("0");
      setErMoveInFee("0");
      setErSecurityDeposit("0");
    }
  }, [erIsShortTermStay, erIsAirbnbStay]);

  useEffect(() => {
    if (!erBundleId.trim()) return;
    if (erBundleOptions.some((o) => o.value === erBundleId)) return;
    setErBundleId("");
  }, [erBundleId, erBundleOptions]);

  useEffect(() => {
    if (!editResidentOpen) return;
    if (erSkipPricingFillRef.current) {
      erSkipPricingFillRef.current = false;
      return;
    }
    if (!erPropertyId.trim() || !erLeaseTerm.trim()) return;
    const pricing = resolveManualResidentPlacementValues({
      propertyId: erPropertyId,
      roomId: erRoomId,
      bundleId: erBundleId,
      leaseTerm: erLeaseTerm,
      leaseTermCustomMode: erLeaseTermCustomMode,
    });
    if (!pricing) return;
    setErRent(pricing.rent);
    setErUtilities(pricing.utilities);
    setErMoveInFee(pricing.moveInFee);
    setErSecurityDeposit(pricing.securityDeposit);
  }, [editResidentOpen, erPropertyId, erRoomId, erBundleId, erLeaseTerm, erLeaseTermCustomMode, propertyTick]);

  const erLeaseTermSelectValue = useMemo(
    () => residentLeaseTermSelectValue(erLeaseTerm, erLeaseTermCustomMode, erLeaseTermPresetValues),
    [erLeaseTerm, erLeaseTermCustomMode, erLeaseTermPresetValues],
  );

  const isEditMonthToMonthLease = isResidentMonthToMonthLease(erLeaseTerm, erPropertyId);

  if (isEditMonthToMonthLease && erMoveOutDate) {
    setErMoveOutDate("");
  }

  const filtered = useMemo(() => {
    // Deduped WITHIN the stage, not across it: two applications from one person
    // are one prospect, but a current tenant who has also started an
    // application for another room is legitimately both, and collapsing the
    // pair would hide whichever row lost.
    const inTab = dedupeResidentsByEmail(
      residentDirectoryRows.filter((resident) => resident.stage === residentsTab),
    );
    const inProperty = propertyFilters.length > 0
      ? inTab.filter((r) => propertyFilters.includes(r.propertyId))
      : inTab;
    // The search box narrows the current stage only; the tab counts stay the stage totals.
    const base = inProperty.filter((r) =>
      matchesPortalListSearch(
        residentSearch,
        r.name,
        r.email,
        r.propertyLabel,
        r.roomLabel,
        r.stage === "potential" ? r.statusLabel : "",
      ),
    );

    return [...base].sort((a, b) => {
      if (propertyFilters.length === 0) {
        const propCmp = a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" });
        if (propCmp !== 0) return propCmp;
      }

      const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (nameCmp !== 0) return nameCmp;

      const aNum = parseInt(a.roomLabel.match(/\d+/)?.[0] ?? "0", 10);
      const bNum = parseInt(b.roomLabel.match(/\d+/)?.[0] ?? "0", 10);
      return aNum - bNum;
    });
  }, [residentDirectoryRows, propertyFilters, residentsTab, residentSearch]);

  const residentTabCounts = useMemo(() => {
    const counts: Record<ResidentsTabId, number> = { potential: 0, current: 0, past: 0 };
    for (const stage of RESIDENT_DIRECTORY_TABS) {
      counts[stage] = dedupeResidentsByEmail(
        residentDirectoryRows.filter((row) => row.stage === stage),
      ).length;
    }
    return counts;
  }, [residentDirectoryRows]);

  const applicationGroups = useMemo(() => {
    void hcTick;
    return buildApplicationGroups(readManagerApplicationRows().map(groupRowInputForRow));
  }, [hcTick]);

  const residentListClusters = useMemo(
    () =>
      buildResidentListClustersByMode(
        filtered.map((res) => ({
          id: res.id,
          name: res.name,
          email: res.email,
          propertyId: res.propertyId,
          propertyLabel: res.propertyLabel,
          roomLabel: res.roomLabel,
          leaseStart: res.leaseStart,
          groupId: res.groupId,
          statusLabel: res.stage === "potential" ? res.statusLabel : "",
          residentSlotFact: res.residentSlotFact,
        })),
        applicationGroups,
        groupMode,
      ),
    [filtered, applicationGroups, groupMode],
  );

  const propertyFilterLabel = useMemo(() => {
    const id = propertyFilters[0];
    if (!id) return "";
    return propertyOptions.find((p) => p.id === id)?.label ?? id;
  }, [propertyFilters, propertyOptions]);

  const { selectedIds, setSelectedIds, toggleSelected, clearSelection } = usePortalRowSelection(residentsTab);
  const listSelectedCount = selectedIds.size;
  const singleListSelectedId = listSelectedCount === 1 ? [...selectedIds][0]! : null;
  const singleListSelectedResident = useMemo(
    () =>
      singleListSelectedId
        ? residentDirectoryRows.find((row) => row.id === singleListSelectedId) ?? null
        : null,
    [residentDirectoryRows, singleListSelectedId],
  );

  const singleListSelectedNeedsSetup = useMemo(() => {
    void hcTick;
    if (!singleListSelectedResident) return false;
    const row = readManagerApplicationRows().find((app) => app.id === singleListSelectedResident.id);
    return !row?.residentUserId;
  }, [hcTick, singleListSelectedResident]);

  // Approve is offered in the ⋯ of a potential resident whose application is awaiting a decision —
  // the same popup as the Applications list and the record's Application tab.
  const singleListSelectedApproveRow = useMemo(() => {
    void hcTick;
    if (!singleListSelectedId) return null;
    const row = readManagerApplicationRows().find((app) => app.id === singleListSelectedId);
    if (!row || row.bucket !== "pending") return null;
    return isWithdrawnApplicationRow(row) || isInProgressApplicationRow(row) ? null : row;
  }, [singleListSelectedId, hcTick]);

  // The completion reminder is per-application (it carries that application's
  // own resume link), so it is offered on a single ticked row — the same shape
  // as Edit and Email setup beside it — rather than fanning out over a
  // selection whose rows would each need their own preview.
  const singleListSelectedReminderRow = useMemo(() => {
    // Cache-invalidation signal, not a value: the application cache
    // `readManagerApplicationRows` consults is module-level, so React cannot
    // see it change on its own.
    void hcTick;
    if (!singleListSelectedId) return null;
    const row = readManagerApplicationRows().find((app) => app.id === singleListSelectedId);
    if (!row || !shouldOfferApplicationCompletionReminder(row)) return null;
    return row;
  }, [singleListSelectedId, hcTick]);

  // C252 (U035): every Potential row that can be chased to finish its
  // application, keyed by application id (the same id `ManagerResidentListRow`
  // uses) — lets the list row itself offer the nudge instead of requiring a
  // checkbox selection first.
  const nudgeEligibleResidentIds = useMemo(() => {
    void hcTick;
    const ids = new Set<string>();
    for (const row of readManagerApplicationRows()) {
      if (shouldOfferApplicationCompletionReminder(row)) ids.add(row.id);
    }
    return ids;
  }, [hcTick]);

  const activeResidentId = residentIdProp ? decodeURIComponent(residentIdProp) : null;
  const selected = useMemo(
    () => (activeResidentId ? residentDirectoryRows.find((r) => r.id === activeResidentId) ?? null : null),
    [residentDirectoryRows, activeResidentId],
  );

  const logResidentActivity = useCallback(
    (label: string) => {
      if (!selected?.id) return;
      appendManagerResidentActivityLog(selected.id, label);
      setActivityLogTick((n) => n + 1);
    },
    [selected],
  );

  if (activeResidentId !== prevSelectedId) {
    setPrevSelectedId(activeResidentId);
    if (activeResidentId) {
      setChargeBucket("pending");
      setResidentServicesBucket("pending");
      setResidentLeasePipelineTab("manager");
    }
  }

  const residentCharges = useMemo<HouseholdCharge[]>(() => {
    void hcTick;
    if (!selected?.email) return [];
    return readChargesForManagerResident(selected.email, userId ?? null);
  }, [selected, hcTick, userId]);

  const importReviewLease = useMemo<LeasePipelineRow | null>(() => {
    void leaseTick;
    if (!importReviewLeaseId) return null;
    return readLeasePipeline(userId).find((row) => row.id === importReviewLeaseId) ?? null;
  }, [importReviewLeaseId, leaseTick, userId]);

  const residentLeaseRows = useMemo<LeasePipelineRow[]>(() => {
    void leaseTick;
    if (!selected?.email) return [];
    return leasePipelineRowsForManagerResident(userId, selected.email, selected.id);
  }, [leaseTick, selected, userId]);

  const residentLeasePipelineCounts = useMemo(
    () => countLeaseListTabs(residentLeaseRows),
    [residentLeaseRows],
  );

  const residentLeaseRowsInPipelineTab = useMemo(
    () => residentLeaseRows.filter((row) => leaseRowMatchesListTab(row, residentLeasePipelineTab)),
    [residentLeaseRows, residentLeasePipelineTab],
  );

  useEffect(() => {
    if (!selected?.id || residentLeaseRows.length === 0) return;
    if (residentLeasePipelineCounts[residentLeasePipelineTab] > 0) return;
    const fallback = RESIDENT_DETAIL_LEASE_PIPELINE_TABS.find(
      (tab) => residentLeasePipelineCounts[tab.id] > 0,
    );
    if (fallback) setResidentLeasePipelineTab(fallback.id);
  }, [residentLeasePipelineCounts, residentLeasePipelineTab, residentLeaseRows.length, selected?.id]);

  useEffect(() => {
    if (!selected?.id) {
      setActiveResidentLeaseId(null);
      return;
    }
    setActiveResidentLeaseId((current) => {
      if (current && residentLeaseRowsInPipelineTab.some((row) => row.id === current)) return current;
      return residentLeaseRowsInPipelineTab[0]?.id ?? null;
    });
  }, [residentLeaseRowsInPipelineTab, selected?.id]);

  const residentLease = useMemo<LeasePipelineRow | null>(() => {
    if (residentLeaseRowsInPipelineTab.length === 0) return null;
    if (activeResidentLeaseId) {
      return (
        residentLeaseRowsInPipelineTab.find((row) => row.id === activeResidentLeaseId) ??
        residentLeaseRowsInPipelineTab[0] ??
        null
      );
    }
    return residentLeaseRowsInPipelineTab[0] ?? null;
  }, [activeResidentLeaseId, residentLeaseRowsInPipelineTab]);

  const residentWorkOrders = useMemo(() => {
    void workOrderTick;
    if (!selected?.email) return [];
    const email = selected.email.trim().toLowerCase();
    return readManagerWorkOrderRows()
      .filter((row) => row.residentEmail?.trim().toLowerCase() === email)
      .sort((a, b) => {
        const bucketOrder = { open: 0, scheduled: 1, completed: 2 } as const;
        const cmp = bucketOrder[a.bucket] - bucketOrder[b.bucket];
        if (cmp !== 0) return cmp;
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      });
  }, [selected, workOrderTick]);

  const residentServiceRequests = useMemo<ServiceRequest[]>(() => {
    void srTick;
    if (!selected?.email) return [];
    // All statuses — manager sees pending (to approve/deny), approved, returned, denied
    return readServiceRequestsForResident(selected.email).sort((a, b) => {
      const order = { pending: 0, approved: 1, returned: 2, denied: 3 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });
  }, [selected, srTick]);

  const residentLedgerRows = useMemo(() => {
    const roomNumber = selected?.roomLabel?.replace(/^room\s+/i, "").trim() ?? "";
    return residentCharges.map((charge) => {
      const row = householdChargeToLedgerRow(charge);
      return roomNumber ? { ...row, roomNumber } : row;
    });
  }, [residentCharges, selected?.roomLabel]);

  const residentPaymentBucketCounts = useMemo(() => {
    const counts: Record<ManagerPaymentBucket, number> = { pending: 0, overdue: 0, paid: 0 };
    for (const row of residentLedgerRows) counts[row.bucket] += 1;
    return counts;
  }, [residentLedgerRows]);

  useEffect(() => {
    if (!paymentIdProp || !residentLedgerRows.length) return;
    const decoded = decodeURIComponent(paymentIdProp);
    const match = residentLedgerRows.find((row) => row.id === decoded);
    if (match && match.bucket !== chargeBucket) setChargeBucket(match.bucket);
  }, [paymentIdProp, residentLedgerRows, chargeBucket]);

  const residentLedgerRowsForBucket = useMemo(() => {
    const filtered = residentLedgerRows.filter((row) => row.bucket === chargeBucket);
    const direction = chargeBucket === "paid" ? "desc" : "asc";
    return [...filtered].sort((a, b) =>
      compareDueDateMs(a.dueDateSortMs, b.dueDateSortMs, direction),
    );
  }, [residentLedgerRows, chargeBucket]);

  const selectedApplicationRow = useMemo<DemoApplicantRow | null>(() => {
    void hcTick;
    if (!selected) return null;
    return readManagerApplicationRows().find((row) => row.id === selected.id) ?? null;
  }, [selected, hcTick]);

  const selectedHasPortalAccount = Boolean(selectedApplicationRow?.residentUserId);

  const residentCosignerSignerIds = useMemo(
    () => (selectedApplicationRow ? signerAppIdsForCosignerLookup([selectedApplicationRow]) : []),
    [selectedApplicationRow],
  );
  const residentCosignerSubmissionsBySigner = useCosignerSubmissionsMap(residentCosignerSignerIds);
  const selectedApplicationCosigners = useMemo(() => {
    if (!selectedApplicationRow) return [];
    const key = normalizeApplicationAxisId(selectedApplicationRow.id).toUpperCase();
    return residentCosignerSubmissionsBySigner.get(key) ?? [];
  }, [selectedApplicationRow, residentCosignerSubmissionsBySigner]);

  // The Application tab's counts: this resident's own application, under the one tab it belongs to.
  const residentApplicationBucketCounts = useMemo(() => {
    const counts: Record<ResidentRecordStatusBucketId, number> = { incomplete: 0, pending: 0, approved: 0, rejected: 0 };
    if (selectedApplicationRow) counts[residentApplicationStatusBucket(selectedApplicationRow)] += 1;
    return counts;
  }, [selectedApplicationRow]);

  // The Background check tab's counts: the one check this resident has, mapped from its status.
  const selectedBackgroundCheckBucket = selectedApplicationRow
    ? residentBackgroundCheckStatusBucket(selectedApplicationRow)
    : "incomplete";
  const residentBackgroundCheckBucketCounts = useMemo(() => {
    const counts: Record<ResidentRecordStatusBucketId, number> = { incomplete: 0, pending: 0, approved: 0, rejected: 0 };
    if (selectedApplicationRow) counts[selectedBackgroundCheckBucket] += 1;
    return counts;
  }, [selectedApplicationRow, selectedBackgroundCheckBucket]);

  // Open on the tab the record is under; the manager can still look at the others.
  const selectedApplicationBucket = selectedApplicationRow
    ? residentApplicationStatusBucket(selectedApplicationRow)
    : null;
  useEffect(() => {
    if (selectedApplicationBucket) setResidentApplicationBucket(selectedApplicationBucket);
  }, [selectedApplicationBucket, selectedApplicationRow?.id]);
  useEffect(() => {
    if (selectedApplicationRow) setResidentBackgroundCheckBucket(selectedBackgroundCheckBucket);
  }, [selectedBackgroundCheckBucket, selectedApplicationRow?.id]);

  const openResidentDetailSettings = useCallback((tab: ManagerPortalSettingsTab) => {
    setResidentDetailSettingsTab(tab);
    setResidentDetailSettingsOpen(true);
  }, []);

  const activeCosignerIndexParam = searchParams.get("cosigner");
  const activeCosignerIndex =
    activeCosignerIndexParam != null && /^\d+$/.test(activeCosignerIndexParam)
      ? parseInt(activeCosignerIndexParam, 10)
      : null;
  const activeCosignerSubmission =
    activeCosignerIndex != null &&
    activeCosignerIndex >= 0 &&
    activeCosignerIndex < selectedApplicationCosigners.length
      ? selectedApplicationCosigners[activeCosignerIndex]!
      : null;

  useEffect(() => {
    if (!paymentIdProp || activeDetailTab !== "payments") {
      setEmbeddedPaymentFooterActions(null);
    }
  }, [paymentIdProp, activeDetailTab]);

  const handleScreeningUpdated = useCallback(() => {
    void syncManagerApplicationsFromServer({ force: true, managerUserId: userId }).then(() => setHcTick((n) => n + 1));
  }, [userId]);

  // The resident's Application section is hidden for a LINKED (co-managed)
  // property when the co-manager lacks the `applications` grant on it. Own
  // properties always show it.
  const showResidentApplication = useMemo(() => {
    void hcTick;
    const pid = selected?.propertyId?.trim() || "";
    if (!userId || !pid) return true;
    if (!collectLinkedPropertyIds(userId).has(pid)) return true;
    return collectLinkedPropertyIdsForModule(userId, "applications").has(pid);
  }, [selected, userId, hcTick]);

  // Same gating for the resident's Lease section + Download lease button: hidden
  // on a LINKED property when the co-manager lacks the `leases` grant.
  const showResidentLease = useMemo(() => {
    void hcTick;
    const pid = selected?.propertyId?.trim() || "";
    if (!userId || !pid) return true;
    if (!collectLinkedPropertyIds(userId).has(pid)) return true;
    return collectLinkedPropertyIdsForModule(userId, "leases").has(pid);
  }, [selected, userId, hcTick]);

  // The person's OWN stage decides their profile tabs, not the list segment
  // the manager happened to arrive from — a deep link into
  // /residents/current/<id> for someone whose lease is unsigned must still show
  // the prospect's tabs.
  const selectedStage: ResidentsTabId = selected?.stage ?? residentsTab;

  const managerPortfolioPropertyIds = useMemo(
    () => (userId ? buildManagerPropertyFilterOptions(userId).map((option) => option.id) : []),
    [userId, propertyTick],
  );

  const residentDetailTabsAvailable = useMemo((): ResidentDetailTabId[] => {
    return [...RESIDENT_DETAIL_TABS_BY_STAGE[selectedStage]];
  }, [selectedStage]);

  const resolvedDetailTab = residentDetailTabsAvailable.includes(activeDetailTab)
    ? activeDetailTab
    : (residentDetailTabsAvailable[0] ?? "payments");

  // Overview's "Needs you": one line per move-in form that is past due. Fetches only while that
  // Overview is open for someone who can have forms (never for a prospect).
  const moveInNeedsYou = useResidentMoveInNeedsYou({
    userId: userId ?? null,
    applicationId: selected?.id ?? null,
    residentName: selected?.name ?? "",
    enabled: Boolean(selected) && resolvedDetailTab === "overview" && selectedStage !== "potential",
  });


  // `threadReading` must stay FALSE here. Under
  // `html[data-communication-thread-reading]` globals.css hides the mobile nav
  // bar and locks `#portal-main-content` to the viewport with `overflow:hidden`,
  // which is only survivable on a surface that renders the inbox back header —
  // and this one deliberately does not: `ManagerResidentDetailInbox` passes no
  // `controlledExpandedId`, so `ManagerInbox` sets `onBack={undefined}` and the
  // resident-detail chrome (Back to residents + the profile tab strip) is the
  // only way out. With the lock on, that chrome and the composer are both pushed
  // outside a page that can no longer scroll, so the manager is stranded on a
  // phone. globals.css already assumes this: its resident-detail Communication
  // rules are scoped `:not([data-communication-thread-reading])`.
  useCommunicationSurfaceChrome({
    active: Boolean(residentIdProp && resolvedDetailTab === "communication"),
    threadReading: false,
    // Resident-detail Communication is always a single open thread (no list pane),
    // so treat it like an active conversation for assistant chrome.
    threadSelected: Boolean(residentIdProp && resolvedDetailTab === "communication"),
    // Hide the floating FAB on resident Communication — the inline Ask PropLane
    // Assistant strip above the composer is the entry point (same as main Communication).
    hideAssistantFab: Boolean(residentIdProp && resolvedDetailTab === "communication"),
  });

  const selectedServiceResident = useMemo<(ManagerServiceResidentOption & { assignedRoomChoice?: string }) | null>(() => {
    if (!selected?.email?.trim()) return null;
    const appRow = selectedApplicationRow;
    const assignedRoomChoice =
      appRow?.assignedRoomChoice?.trim() || appRow?.application?.roomChoice1?.trim() || "";
    return {
      residentEmail: selected.email.trim().toLowerCase(),
      residentName: selected.name.trim() || "Resident",
      propertyId: selected.propertyId.trim(),
      propertyLabel: selected.propertyLabel.trim() || "Property",
      roomLabel: selected.roomLabel.trim(),
      assignedRoomChoice: assignedRoomChoice || undefined,
    };
  }, [selected, selectedApplicationRow]);

  const canAddResidentServiceItem = Boolean(
    selectedServiceResident?.residentEmail && selectedServiceResident.propertyId,
  );

  const residentUnifiedServicesCounts = useMemo(() => {
    const c: Record<ResidentUnifiedServicesBucket, number> = {
      pending: 0,
      scheduled: 0,
      completed: 0,
    };
    for (const req of residentServiceRequests) {
      c[residentUnifiedServiceBucketForRequest(req)] += 1;
    }
    for (const row of residentWorkOrders) {
      c[residentUnifiedServiceBucketForWorkOrder(row)] += 1;
    }
    return c;
  }, [residentServiceRequests, residentWorkOrders]);

  const [residentServicesSearch, setResidentServicesSearch] = useState("");

  const residentFilteredServiceRequests = useMemo(
    () =>
      residentServiceRequests
        .filter((req) => residentUnifiedServiceBucketForRequest(req) === residentServicesBucket)
        .filter((req) =>
          matchesPortalListSearch(residentServicesSearch, req.offerName, managerServiceRequestPricingSummary(req)),
        )
        .slice()
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()),
    [residentServiceRequests, residentServicesBucket, residentServicesSearch],
  );

  const residentFilteredWorkOrders = useMemo(
    () =>
      residentWorkOrders
        .filter((row) => residentUnifiedServiceBucketForWorkOrder(row) === residentServicesBucket)
        .filter((row) =>
          matchesPortalListSearch(residentServicesSearch, row.title, row.status, row.cost ?? ""),
        )
        .slice()
        .sort((a, b) => (b.scheduledAtIso ?? "").localeCompare(a.scheduledAtIso ?? "")),
    [residentWorkOrders, residentServicesBucket, residentServicesSearch],
  );

  const residentServicesHasRows =
    residentFilteredServiceRequests.length > 0 || residentFilteredWorkOrders.length > 0;

  const residentServiceDetailItem = useMemo(() => {
    if (!serviceItemIdProp) return null;
    if (serviceItemIdProp.startsWith("request-")) {
      const id = serviceItemIdProp.slice("request-".length);
      const req = residentServiceRequests.find((row) => row.id === id);
      return req ? ({ kind: "request" as const, req } as const) : null;
    }
    if (serviceItemIdProp.startsWith("work-order-")) {
      const id = serviceItemIdProp.slice("work-order-".length);
      const row = residentWorkOrders.find((entry) => entry.id === id);
      return row ? ({ kind: "work-order" as const, row } as const) : null;
    }
    return null;
  }, [residentServiceRequests, residentWorkOrders, serviceItemIdProp]);

  async function sendResidentMessage(
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject?: string; body?: string; scheduleAt?: string },
  ) {
    if (!selected || messageBusy) return;
    const subject = draft?.subject?.trim() || "";
    const body = draft?.body?.trim() || "";
    if (!subject || !body) {
      showToast("Add a subject and message.");
      return;
    }
    const viaEmail = channels?.viaEmail !== false;
    const viaSms = channels?.viaSms === true;

    if (draft?.scheduleAt) {
      setMessageBusy(true);
      try {
        const res = await fetch("/api/portal/scheduled-inbox-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject,
            body,
            sendAt: draft.scheduleAt,
            deliverViaEmail: viaEmail,
            deliverViaSms: viaSms,
            senderPortal: "manager",
            recipientEmail: selected.email.trim().toLowerCase(),
            recipientName: selected.name.trim(),
          }),
        });
        if (!res.ok) {
          const payload = (await res.json()) as { error?: string };
          showToast(payload.error ?? "Could not schedule message.");
          return;
        }
        setMessageOpen(false);
        setMessageScheduledRefresh((n) => n + 1);
        showToast("Message scheduled.");
      } finally {
        setMessageBusy(false);
      }
      return;
    }

    setMessageBusy(true);
    setMessageOpen(false);
    try {
      const result = await deliverPortalInboxMessage({
        eventCategory: "messages",
        fromName: managerEmail ?? "Property Manager",
        toEmails: [selected.email],
        subject,
        text: body,
        deliverViaEmail: viaEmail,
        deliverViaSms: viaSms,
      });
      if (!result.ok) {
        showToast(result.error ?? "Message could not be sent.");
        return;
      }
      invalidatePersistedInboxCache(MANAGER_INBOX_STORAGE_KEY);
      const fresh = await syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true });
      persistInbox(MANAGER_INBOX_STORAGE_KEY, fresh as PersistedInboxThread[]);
      setInboxTick((n) => n + 1);
      showToast(
        result.skipped
          ? "Message saved to PropLane inbox."
          : viaSms && viaEmail
            ? "Message sent via email, SMS, and PropLane inbox."
            : viaSms
              ? "Message sent via SMS and PropLane inbox."
              : "Message sent via inbox and email.",
      );
      if (messageReminderForPayment) {
        logResidentActivity("Payment reminder sent");
        setMessageReminderForPayment(false);
      }
    } finally {
      setMessageBusy(false);
    }
  }

  async function sendResidentAccountEmail(
    res: ActiveResident,
    opts?: {
      channels?: { viaInbox?: boolean; viaEmail?: boolean; viaSms?: boolean };
      draft?: { subject?: string; body?: string; scheduleAt?: string };
      quiet?: boolean;
    },
  ) {
    const toast = (message: string) => {
      if (!opts?.quiet) showToast(message);
    };
    setWelcomeEmailBusyForResident(res.id);
    try {
      const subject =
        opts?.draft?.subject?.trim() ||
        (res.manuallyAdded ? EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT : RESIDENT_WELCOME_EMAIL_SUBJECT);
      const signupUrl = residentAccountCreationUrl(window.location.origin, res.axisId);
      const managerReachability = await fetchManagerReachabilityForWelcome();
      const defaultBody = res.manuallyAdded
        ? buildExistingResidentWelcomeEmailBody({
            residentName: res.name,
            axisId: res.axisId,
            signupUrl,
            propertyLabel: res.propertyLabel,
            managerReachability,
          })
        : buildResidentWelcomeEmailBody({
            residentName: res.name,
            axisId: res.axisId,
            signupUrl,
            managerReachability,
          });
      const body = opts?.draft?.body?.trim() || defaultBody;
      const viaEmail = opts?.channels?.viaEmail !== false && Boolean(res.email.trim());
      const viaSms = opts?.channels?.viaSms !== false;
      const viaInbox = opts?.channels?.viaInbox !== false;

      const customized = Boolean(opts?.draft?.body?.trim() && opts.draft.body.trim() !== defaultBody.trim());

      if (opts?.draft?.scheduleAt) {
        const response = await fetch("/api/portal/scheduled-inbox-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            subject,
            body,
            sendAt: opts.draft.scheduleAt,
            deliverViaEmail: viaEmail,
            deliverViaSms: viaSms,
            recipientEmail: res.email.trim().toLowerCase(),
            recipientName: res.name.trim(),
            senderPortal: "manager",
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          toast(data.error ?? "Could not schedule account setup message.");
          return;
        }
        toast("Account setup message scheduled.");
        return;
      }

      if (res.manuallyAdded && !customized && (viaEmail || viaSms || viaInbox)) {
        const response = await fetch("/api/portal/onboard-existing-resident", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            applicationId: res.axisId,
            sendWelcomeEmail: true,
            viaEmail,
            viaSms,
            viaInbox,
          }),
        });
        const data = (await response.json()) as { ok?: boolean; error?: string; mailtoHref?: string; welcomeEmailSent?: boolean };
        if (response.ok && data.ok) {
          const sent = [
            viaEmail ? "email" : null,
            viaSms ? "SMS" : null,
            viaInbox ? "PropLane inbox" : null,
          ].filter(Boolean);
          toast(
            sent.length === 0
              ? "Account setup message sent."
              : sent.length === 1
                ? `Account setup message sent via ${sent[0]}.`
                : `Account setup message sent via ${sent.slice(0, -1).join(", ")} and ${sent[sent.length - 1]}.`,
          );
          return;
        }
        if (typeof data.mailtoHref === "string") {
          const { openMailtoHref } = await import("@/lib/resident-welcome-email");
          openMailtoHref(data.mailtoHref);
          const err = (data.error ?? "").toLowerCase();
          showToast(
            err.includes("not configured") || err.includes("resend_api_key")
              ? "Email provider not configured. Opened a draft in your mail app."
              : `Could not send automatically. Opened a draft in your mail app.`,
          );
          return;
        }
        toast(data.error ?? "Could not send account setup email.");
        return;
      }

      if (opts?.channels && (viaSms || viaEmail || viaInbox)) {
        const response = await fetch("/api/portal/send-inbox-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            fromName: managerEmail ?? "Property Manager",
            toEmails: [res.email],
            subject,
            text: body,
            deliverToPortalInbox: viaInbox,
            deliverViaEmail: viaEmail,
            deliverViaSms: viaSms,
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; skipped?: boolean; error?: string };
        if (!response.ok || !data.ok) {
          toast(data.error ?? "Could not send account setup message.");
          return;
        }
        toast(
          data.skipped
            ? "Account setup message saved to PropLane inbox."
            : viaSms && viaEmail
              ? "Account setup message sent via email, SMS, and PropLane inbox."
              : viaSms
                ? "Account setup message sent via SMS and PropLane inbox."
                : "Account setup message sent via email and PropLane inbox.",
        );
        return;
      }

      const endpoint = res.manuallyAdded
        ? "/api/portal/onboard-existing-resident"
        : "/api/portal/send-resident-welcome";
      const payload = res.manuallyAdded
        ? { applicationId: res.axisId, sendWelcomeEmail: true }
        : { to: res.email, residentName: res.name, axisId: res.axisId };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string; mailtoHref?: string; welcomeEmailSent?: boolean };
      if (response.ok && data.ok) {
        showToast(res.manuallyAdded ? "Portal setup email sent." : "Account setup email sent.");
        return;
      }
      if (typeof data.mailtoHref === "string") {
        const { openMailtoHref } = await import("@/lib/resident-welcome-email");
        openMailtoHref(data.mailtoHref);
        const err = (data.error ?? "").toLowerCase();
        showToast(
          err.includes("not configured") || err.includes("resend_api_key")
            ? "Email provider not configured. Opened a draft in your mail app."
            : `Could not send automatically. Opened a draft in your mail app.`,
        );
        return;
      }
      showToast(data.error ?? "Could not send account setup email.");
    } catch {
      showToast("Could not send account setup email.");
    } finally {
      setWelcomeEmailBusyForResident(null);
    }
  }

  async function sendLeaseSigningReminder(
    res: ActiveResident,
    leaseId: string,
    subject: string,
    body: string,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
  ) {
    setLeaseReminderBusy(true);
    try {
      const response = await fetch("/api/portal/send-inbox-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromName: managerEmail ?? "Property Manager",
          toEmails: [res.email],
          subject,
          text: body,
          deliverToPortalInbox: true,
          deliverViaEmail: channels?.viaEmail !== false,
          deliverViaSms: channels?.viaSms === true,
          senderPortal: "manager",
        }),
      });

      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; skipped?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        showToast(data.error ?? "Could not send lease signing reminder.");
        return;
      }

      appendLeaseThreadMessage(leaseId, "manager", "Sent lease-signing reminder to resident.", userId);
      setLeaseTick((n) => n + 1);
      logResidentActivity("Lease signing reminder sent");
      if (data.skipped) {
        showToast("Reminder sent to PropLane inbox (demo email, no external email sent).");
      } else {
        showToast("Lease-signing reminder sent via email and PropLane inbox.");
      }
    } catch {
      showToast("Could not send lease signing reminder.");
    } finally {
      setLeaseReminderBusy(false);
    }
  }

  function openLeaseSigningReminderPreview(res: ActiveResident, lease: LeasePipelineRow) {
    const recipient = res.email.trim();
    if (!recipient || !recipient.includes("@")) {
      showToast("Resident email is missing or invalid.");
      return;
    }
    const unit = lease.unit.trim() || "your unit";
    const leaseStart = lease.application?.leaseStart?.trim();
    const leaseEnd = lease.application?.leaseEnd?.trim();
    const dateLine = leaseStart
      ? leaseEnd
        ? `Lease dates: ${leaseStart} to ${leaseEnd}`
        : `Lease start date: ${leaseStart}`
      : "";
    const subject = `Reminder: sign your lease for ${unit}`;
    const body = buildLeaseReadyForResidentMessage({
      residentName: res.name.split(" ")[0] ?? res.name,
      residentEmail: recipient,
      unit,
      variant: "reminder",
      dateLine,
    });

    setLeaseReminderPreview({
      res,
      leaseId: lease.id,
      recipient,
      subject,
      body,
    });
  }

  /** Send lease opens the one screen for this resident's lease (terms, document, schedule, message). */
  function openLeaseSendPreview(_res: ActiveResident, lease: LeasePipelineRow) {
    setSendLeaseTarget({ leaseId: lease.id });
  }

  function openSendLeaseForApplication(applicationId: string) {
    const existing = readManagerApplicationRows().find((row) => row.id === applicationId);
    const lease = existing?.email
      ? leasePipelineRowsForManagerResident(userId, existing.email, applicationId)[0]
      : undefined;
    setSendLeaseTarget(lease ? { leaseId: lease.id } : { applicationId });
  }

  const setApplicationBucket = async (
    id: string,
    nextBucket: ManagerApplicationBucket,
    opts?: { skipWelcomeEmail?: boolean },
  ) => {
    const row = readManagerApplicationRows().find((candidate) => candidate.id === id);
    const propertyId =
      row?.assignedPropertyId?.trim() ||
      row?.propertyId?.trim() ||
      row?.application?.propertyId?.trim() ||
      "";
    const result = await transitionApplicationBucket(id, nextBucket, {
      userId: userId ?? null,
      skipWelcomeEmail: opts?.skipWelcomeEmail,
      // Without this a manager who switched automation on sees it do nothing when they approve
      // from this surface.
      automation: applicationAutomation.forProperty(propertyId),
    });
    if (!result) return null;
    setHcTick((n) => n + 1);
    setLeaseTick((n) => n + 1);
    if (result.blocked) {
      showToast(result.message ?? "That change could not be saved.");
      return result;
    }
    const msg =
      nextBucket === "approved"
        ? opts?.skipWelcomeEmail
          ? "Application approved (no setup email sent)."
          : result.welcomeSent
            ? "Application approved. A welcome email with portal setup was sent to the applicant."
            : "Application approved."
        : nextBucket === "rejected"
          ? "Application rejected."
          : "Moved to pending.";
    showToast(msg);
    return result;
  };

  /** Decline is one click; the toast's Undo restores the application (shared with the Applications list). */
  const declineApplicationRow = async (row: DemoApplicantRow) => {
    const propertyId =
      row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
    await declineApplicationWithUndo({
      row,
      showToast,
      run: async (id, next) => {
        const result = await transitionApplicationBucket(id, next, {
          userId: userId ?? null,
          automation: applicationAutomation.forProperty(propertyId),
        });
        setHcTick((n) => n + 1);
        setLeaseTick((n) => n + 1);
        return result;
      },
    });
  };

  const deleteApplicationForRow = async (row: DemoApplicantRow) => {
    if (!(await confirm({ description: `Delete the application for ${row.name || row.email}? This cannot be undone.` }))) return;
    const nextRows = readManagerApplicationRows().filter((candidate) => candidate.id !== row.id);
    writeManagerApplicationRows(nextRows);
    setHcTick((n) => n + 1);

    const result = await deleteManagerApplicationFromServer(row.id);
    if (!result.ok) {
      void syncManagerApplicationsFromServer({ force: true, managerUserId: userId }).then(() => setHcTick((n) => n + 1));
      showToast(result.error ?? "Could not delete application.");
      return;
    }

    removeAllApplicationCharges(row.id, userId ?? null);
    deleteLeasePipelineRowsForResident("", row.id, userId ?? null);

    showToast("Application deleted.");
    navigate(`${portalBase}/residents/${residentsTab}`);
  };

  const sendApplicationCompletionReminder = async (
    row: DemoApplicantRow,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject?: string; body?: string },
  ) => {
    if (applicationReminderBusyId) return;
    setApplicationReminderBusyId(row.id);
    try {
      if (isDemoModeActive()) {
        logResidentActivity("Application reminder sent");
        showToast("Application reminder sent to the applicant.");
        return;
      }
      const res = await fetch("/api/portal/send-application-completion-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          applicationId: row.id,
          viaEmail: channels?.viaEmail !== false,
          viaSms: channels?.viaSms === true,
          subject: draft?.subject?.trim() || undefined,
          text: draft?.body?.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; mailtoHref?: string };
      if (res.ok && data.ok) {
        logResidentActivity("Application reminder sent");
        showToast("Application reminder sent to the applicant.");
        return;
      }
      if (typeof data.mailtoHref === "string" && data.mailtoHref) {
        const { openMailtoHref } = await import("@/lib/resident-welcome-email");
        openMailtoHref(data.mailtoHref);
        showToast(
          res.status === 503
            ? "Email isn't configured. Opened a draft in your mail app instead."
            : `Couldn't send automatically${data.error ? ` (${data.error})` : ""}. Opened a draft in your mail app.`,
        );
        return;
      }
      showToast(data.error ?? "Could not send the application reminder.");
    } catch {
      showToast("Could not send the application reminder.");
    } finally {
      setApplicationReminderBusyId(null);
      setApplicationReminderPreview(null);
    }
  };

  const openApplicationCompletionReminderPreview = async (row: DemoApplicantRow) => {
    if (applicationReminderPreviewBusyId || applicationReminderBusyId) return;
    setApplicationReminderPreviewBusyId(row.id);
    try {
      if (isDemoModeActive()) {
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        const text = buildApplicationCompletionReminderBody({
          applicantName: row.name || undefined,
          propertyTitle: row.property || undefined,
          resumeUrl: inProgressApplicationResumeUrl(origin, row),
          signInUrl: `${origin}/auth/sign-in?role=resident`,
        });
        setApplicationReminderPreview({
          row,
          to: row.email?.trim() || "the applicant",
          subject: APPLICATION_COMPLETION_REMINDER_SUBJECT,
          text,
        });
        return;
      }
      const res = await fetch("/api/portal/send-application-completion-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ applicationId: row.id, preview: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        preview?: { to?: string; subject?: string; text?: string };
      };
      if (res.ok && data.ok && data.preview) {
        setApplicationReminderPreview({
          row,
          to: data.preview.to ?? "",
          subject: data.preview.subject ?? APPLICATION_COMPLETION_REMINDER_SUBJECT,
          text: data.preview.text ?? "",
        });
        return;
      }
      showToast(data.error ?? "Could not load the reminder preview.");
    } catch {
      showToast("Could not load the reminder preview.");
    } finally {
      setApplicationReminderPreviewBusyId(null);
    }
  };

  /**
   * Mint a shareable link for the selected property.
   *
   * Deliberately NOT the resident account-setup link: that one is bound to one
   * person's identity and whoever holds it becomes that resident, which is why
   * the server never hands it to a browser. This link carries a PROPERTY, binds
   * nobody, and produces a request the manager approves — so it is safe to post
   * in a building group chat, which is the whole point when moving an existing
   * portfolio across.
   */
  async function openResidentEmailSetup(resident: ActiveResident) {
    const signupUrl = residentAccountCreationUrl(window.location.origin, resident.axisId);
    const managerReachability = await fetchManagerReachabilityForWelcome();
    const previewBody = buildResidentWelcomeEmailBody({
      residentName: resident.name,
      axisId: resident.axisId,
      signupUrl,
      managerReachability,
    });
    setWelcomePreviewContent(previewBody);
    setWelcomePreviewFor(resident);
  }

  function openEditResidentModal(residentId?: string) {
    const targetId = residentId ?? selected?.id;
    if (!targetId) return;
    const row = readManagerApplicationRows().find((r) => r.id === targetId);
    if (!row) {
      showToast("Resident record not found.");
      return;
    }
    const app = row.application;
    const assignedPropId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || app?.propertyId?.trim() || "";
    const assignedRoomChoice = row.assignedRoomChoice?.trim() || app?.roomChoice1?.trim() || "";
    const storedBundleId = app?.bundleId?.trim() ?? "";
    const rentedByRoom = assignedPropId ? isPropertyRentedByRoom(assignedPropId) : false;
    let roomIdForForm = "";
    if (rentedByRoom && !storedBundleId && assignedPropId && assignedRoomChoice) {
      if (assignedRoomChoice.startsWith(`${assignedPropId}${LISTING_ROOM_CHOICE_SEP}`)) {
        roomIdForForm = assignedRoomChoice.slice(`${assignedPropId}${LISTING_ROOM_CHOICE_SEP}`.length);
      }
    }
    setErName(row.name || app?.fullLegalName?.trim() || "");
    setErEmail(row.email?.trim() || app?.email?.trim() || "");
    setErPhone(row.manualResidentDetails?.phone?.trim() || app?.phone?.trim() || "");
    setErPropertyId(assignedPropId);
    setErRoomId(roomIdForForm);
    setErBundleId(storedBundleId);
    const assignedPropIdForLease = assignedPropId;
    const storedLeaseTerm = row.manualResidentDetails?.leaseTerm || app?.leaseTerm || "";
    const erDisplayLeaseTerm = listingLeaseTermToResidentValue(storedLeaseTerm) || storedLeaseTerm;
    const erOpts = residentLeaseTermOptionsForProperty(assignedPropIdForLease).map((o) => o.value);
    const erCustomMode =
      erDisplayLeaseTerm === RESIDENT_LEASE_TERM_CUSTOM ||
      shouldUseResidentLeaseCustomMode(erDisplayLeaseTerm, erOpts);
    setErLeaseTerm(
      erCustomMode && erDisplayLeaseTerm === RESIDENT_LEASE_TERM_CUSTOM
        ? storedLeaseTerm
        : erDisplayLeaseTerm,
    );
    setErLeaseTermCustomMode(erCustomMode);
    setErMoveInDate(row.manualResidentDetails?.moveInDate || app?.leaseStart || "");
    setErMoveOutDate(row.manualResidentDetails?.moveOutDate || app?.leaseEnd || "");
    const savedRent = Number.isFinite(row.signedMonthlyRent ?? NaN) ? String(row.signedMonthlyRent ?? "") : "";
    setErRent(savedRent || app?.managerRentOverride?.trim() || "");
    const savedUtils = row.manualResidentDetails?.monthlyUtilities != null ? String(row.manualResidentDetails.monthlyUtilities) : "";
    setErUtilities(savedUtils || app?.managerUtilitiesOverride?.trim() || "");
    const savedFee = row.manualResidentDetails?.moveInFee != null ? String(row.manualResidentDetails.moveInFee) : "";
    setErMoveInFee(savedFee || app?.managerMoveInFeeOverride?.trim() || "");
    const savedDeposit = row.manualResidentDetails?.securityDeposit != null ? String(row.manualResidentDetails.securityDeposit) : "";
    setErSecurityDeposit(savedDeposit || app?.managerSecurityDepositOverride?.trim() || "");
    setErNotes(row.manualResidentDetails?.notes || "");
    erSkipPricingFillRef.current = true;
    setEditResidentTargetId(targetId);
    const directoryStage = residentDirectoryRows.find((r) => r.id === targetId)?.stage ?? "current";
    const stageInfo = resolveResidentEditStage({
      row,
      leaseRows: readLeasePipeline(userId),
      directoryStage,
    });
    const editForm: AddPersonForm = {
      ...emptyAddPersonForm("resident"),
      name: row.name || app?.fullLegalName?.trim() || "",
      email: row.email?.trim() || app?.email?.trim() || "",
      phone: row.manualResidentDetails?.phone?.trim() || app?.phone?.trim() || "",
      propertyId: assignedPropId,
      roomId: roomIdForForm,
      bundleId: storedBundleId,
      leaseTerm:
        erCustomMode && erDisplayLeaseTerm === RESIDENT_LEASE_TERM_CUSTOM
          ? storedLeaseTerm
          : erDisplayLeaseTerm,
      leaseTermCustomMode: erCustomMode,
      moveInDate: row.manualResidentDetails?.moveInDate || app?.leaseStart || "",
      moveOutDate: row.manualResidentDetails?.moveOutDate || app?.leaseEnd || "",
      rent: savedRent || app?.managerRentOverride?.trim() || "",
      utilities: savedUtils || app?.managerUtilitiesOverride?.trim() || "",
      moveInFee: savedFee || app?.managerMoveInFeeOverride?.trim() || "",
      securityDeposit: savedDeposit || app?.managerSecurityDepositOverride?.trim() || "",
      notes: row.manualResidentDetails?.notes || "",
      alsoCreate: [...ALSO_CREATE_IDS],
      application: app ? ({ ...app } as AddPersonForm["application"]) : {},
    };
    setEditResidentForm(editForm);
    const editEmail = (row.email?.trim() || app?.email?.trim() || "").toLowerCase();
    setEditResidentRecord({
      ...emptyResidentEditRecord(),
      charges: editEmail ? residentEditChargesFromHousehold(readChargesForManagerResident(editEmail, userId ?? null)) : [],
      signers: residentEditSignersFromLease(stageInfo.lease, stageInfo.stage),
      leaseStatusText: residentEditLeaseStatusText(
        stageInfo.stage,
        stageInfo.lease,
        stageInfo.signedAtIso,
        formatPortalListDate,
        editForm.moveOutDate || null,
      ),
      leaseDocument: residentEditLeaseDocument(stageInfo.lease),
      application: residentEditApplicationFacts(row, {
        assignedPropertyId: assignedPropId,
        assignedRoomChoice,
      }),
    });
    void loadEditResidentDocuments(editEmail);
    setEditResidentContext({
      stage: stageInfo.stage,
      baseline: snapshotResidentEditBaseline({
        ...editForm,
        application: editForm.application as Record<string, unknown>,
      }),
      signedAtIso: stageInfo.signedAtIso,
      leaseId: stageInfo.lease?.id ?? null,
    });
    setEditResidentOpen(true);
  }

  /** The files on this resident, as the Documents step lists them. */
  async function loadEditResidentDocuments(email: string) {
    if (!email.includes("@")) {
      setEditResidentDocs([]);
      return;
    }
    try {
      const res = await fetch("/api/manager-documents?scope=resident", { credentials: "include" });
      const data = (await res.json()) as { documents?: ManagerDocumentDTO[] };
      const docs = (data.documents ?? []).filter(
        (doc) => (doc.scope.residentEmail ?? "").trim().toLowerCase() === email,
      );
      setEditResidentDocs(
        docs.map((doc) => ({
          id: doc.id,
          name: doc.displayName,
          date: doc.createdAt?.slice(0, 10) ?? null,
          kindLabel: DOCUMENT_CATEGORY_LABELS[doc.category] ?? "Other",
        })),
      );
    } catch {
      setEditResidentDocs([]);
    }
  }

  const editResidentEmail = () => {
    const target = readManagerApplicationRows().find((r) => r.id === editResidentTargetId);
    return (target?.email ?? "").trim().toLowerCase();
  };

  async function uploadEditResidentDocument(file: File) {
    const target = readManagerApplicationRows().find((r) => r.id === editResidentTargetId);
    const email = editResidentEmail();
    if (!target || !email.includes("@")) {
      showToast("This resident has no email — the file could not be saved.");
      return;
    }
    try {
      await uploadManagerDocumentForResident(file, "other", {
        residentEmail: email,
        propertyId: target.assignedPropertyId || target.propertyId,
      });
      showToast(`${file.name} added to Documents.`);
      setResidentDocsTick((n) => n + 1);
      await loadEditResidentDocuments(email);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Upload failed.");
    }
  }

  async function downloadEditResidentDocument(id: string) {
    try {
      const res = await fetch(`/api/manager-documents/${id}/signed-url?download=1`, { credentials: "include" });
      const data = (await res.json()) as { url?: string; fileName?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Download failed.");
      const file = await fetch(data.url);
      if (!file.ok) throw new Error("Download failed.");
      const objectUrl = URL.createObjectURL(await file.blob());
      triggerDocumentDownload(objectUrl, data.fileName);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Download failed.");
    }
  }

  async function removeEditResidentDocument(id: string) {
    const doc = editResidentDocs.find((d) => d.id === id);
    if (!(await confirm({ description: `Remove "${doc?.name ?? "this document"}" from this resident?` }))) return;
    try {
      const res = await fetch(`/api/manager-documents/${id}`, { method: "DELETE", credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not remove the document.");
      setResidentDocsTick((n) => n + 1);
      setEditResidentDocs((current) => current.filter((d) => d.id !== id));
      showToast("Document removed.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not remove the document.");
    }
  }

  function saveEditedResident(from?: AddPersonForm, options?: { voidSentLeases?: boolean }) {
    const targetId = editResidentTargetId ?? selected?.id;
    if (!targetId || erSaving) return Promise.resolve();
    const name = (from?.name ?? erName).trim();
    const email = (from?.email ?? erEmail).trim();
    const phone = (from?.phone ?? erPhone).trim();
    const propertyId = (from?.propertyId ?? erPropertyId).trim();
    const roomId = from?.roomId ?? erRoomId;
    const bundleId = from?.bundleId ?? erBundleId;
    const leaseTerm = from?.leaseTerm ?? erLeaseTerm;
    const leaseTermCustomMode = from?.leaseTermCustomMode ?? erLeaseTermCustomMode;
    const moveInDate = from?.moveInDate ?? erMoveInDate;
    const moveOutDate = from?.moveOutDate ?? erMoveOutDate;
    const rentRaw = from?.rent ?? erRent;
    const utilitiesRaw = from?.utilities ?? erUtilities;
    const moveInFeeRaw = from?.moveInFee ?? erMoveInFee;
    const securityDepositRaw = from?.securityDeposit ?? erSecurityDeposit;
    const notes = from?.notes ?? erNotes;
    if (!name) {
      showToast("Enter the resident's name.");
      return Promise.resolve();
    }
    const rows = readManagerApplicationRows();
    const idx = rows.findIndex((r) => r.id === targetId);
    if (idx === -1) {
      showToast("Resident record not found.");
      return;
    }
    const rent = rentRaw.trim() ? Number(rentRaw.replace(/[^\d.]/g, "")) : null;
    const appLeaseFields = residentLeaseTermToApplicationFields(leaseTerm, leaseTermCustomMode, propertyId);
    const erSavingShortTerm = appLeaseFields.rentalType === "short_term";
    const erSavingAirbnb = appLeaseFields.rentalType === "airbnb";
    if (erSavingAirbnb) {
      if (!moveInDate.trim() || !moveOutDate.trim()) {
        showToast("Airbnb stays require move-in and move-out dates.");
        return;
      }
      if (moveOutDate <= moveInDate) {
        showToast("Move-out must be after move-in.");
        return;
      }
    }
    const utilities = erSavingShortTerm || erSavingAirbnb
      ? null
      : utilitiesRaw.trim()
        ? Number(utilitiesRaw.replace(/[^\d.]/g, ""))
        : null;
    const moveInFee = moveInFeeRaw.trim() ? Number(moveInFeeRaw.replace(/[^\d.]/g, "")) : null;
    const secDeposit = securityDepositRaw.trim() ? Number(securityDepositRaw.replace(/[^\d.]/g, "")) : null;
    const propId = propertyId.trim();
    const propLabel = propId ? propertyOptions.find((p) => p.id === propId)?.label ?? rows[idx]!.property : rows[idx]!.property;
    const placement = resolveManualResidentAssignment({
      propertyId: propId,
      roomId: roomId,
      bundleId: bundleId,
    });
    const selectedRoomLabel = placement.placementLabel?.trim() || "";
    const existing = rows[idx]!;
    const newRoomChoice = placement.assignedRoomChoice;
    const applicationAnswerPatch: Record<string, unknown> = {};
    if (from?.application) {
      for (const key of MANAGER_APPLICATION_TEXT_KEYS) {
        if (key in from.application) applicationAnswerPatch[key] = from.application[key] ?? "";
      }
      if ("notEmployed" in from.application) applicationAnswerPatch.notEmployed = Boolean(from.application.notEmployed);
      if ("noPreviousAddress" in from.application) applicationAnswerPatch.noPreviousAddress = Boolean(from.application.noPreviousAddress);
    }
    const baseApplication =
      existing.application ??
      (appLeaseFields.leaseTerm || propId || email.trim() || moveInDate
        ? ({
            propertyId: propId || undefined,
            roomChoice1: newRoomChoice,
            bundleId: placement.bundleId ?? "",
            leaseTerm: appLeaseFields.leaseTerm,
            rentalType: appLeaseFields.rentalType,
            leaseStart: moveInDate || undefined,
            leaseEnd: moveOutDate || undefined,
            fullLegalName: name,
            email: email.trim(),
            phone: phone.trim() || undefined,
          } as DemoApplicantRow["application"])
        : undefined);
    let nextRow: DemoApplicantRow = {
      ...existing,
      name: name,
      email: email.trim() || existing.email,
      property: propLabel,
      assignedPropertyId: propId || undefined,
      assignedRoomChoice: newRoomChoice,
      signedMonthlyRent: rent ?? undefined,
      manualResidentDetails: {
        ...(existing.manualResidentDetails ?? {}),
        phone: phone.trim() || undefined,
        moveInDate: moveInDate || undefined,
        moveOutDate: moveOutDate || undefined,
        monthlyUtilities: utilities ?? undefined,
        moveInFee: moveInFee ?? undefined,
        securityDeposit: secDeposit ?? undefined,
        roomNumber: selectedRoomLabel || undefined,
        leaseTerm: leaseTerm.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      application: baseApplication
        ? {
            ...baseApplication,
            fullLegalName: name || baseApplication.fullLegalName,
            email: email.trim() || baseApplication.email,
            phone: phone.trim() || baseApplication.phone,
            propertyId: propId || baseApplication.propertyId,
            roomChoice1: newRoomChoice ?? (placement.bundleId ? "" : baseApplication.roomChoice1),
            bundleId: placement.bundleId ?? "",
            leaseTerm: appLeaseFields.leaseTerm || baseApplication.leaseTerm,
            rentalType: appLeaseFields.leaseTerm ? appLeaseFields.rentalType : baseApplication.rentalType,
            leaseStart: moveInDate || baseApplication.leaseStart,
            leaseEnd: moveOutDate || baseApplication.leaseEnd,
            managerRentOverride: rentRaw.trim() || baseApplication.managerRentOverride,
            managerUtilitiesOverride: erSavingShortTerm
              ? ""
              : utilitiesRaw.trim() || baseApplication.managerUtilitiesOverride,
            managerMoveInFeeOverride: moveInFeeRaw.trim() || baseApplication.managerMoveInFeeOverride,
            managerSecurityDepositOverride:
              securityDepositRaw.trim() || baseApplication.managerSecurityDepositOverride,
            // The Application step edits these answers; without this they were
            // read, changed and silently dropped on Save.
            ...applicationAnswerPatch,
          }
        : undefined,
    };
    if (nextRow.application) {
      nextRow = mergeApplicationLeaseDatesIntoResidentRow(nextRow, nextRow.application);
    }

    const next = [...rows];
    next[idx] = nextRow;
    setErSaving(true);
    return persistResidentProfileEdit({
      rows: next,
      nextRow,
      managerUserId: userId ?? null,
      voidSentLeases: options?.voidSentLeases,
    })
      .then((result) => {
        if (!result.ok) {
          showToast(result.error ?? "Could not save resident.");
          return;
        }
        setEditResidentOpen(false);
        setEditResidentTargetId(null);
        setEditResidentForm(null);
        setEditResidentContext(null);
        setEditResidentRecord(null);
        setEditResidentDocs([]);
        setHcTick((n) => n + 1);
        setLeaseTick((n) => n + 1);
        // Say what actually propagated. Charges and leases each decline for legitimate reasons
        // — an unresolvable (unlisted/draft) property, a signed or uploaded lease — and
        // reporting a flat "Resident updated." for an edit that changed nothing downstream is
        // how "I set changes to the resident and it does not update the application, lease or
        // payments" goes unexplained.
        showToast(
          result.sync?.skipped?.length
            ? `Resident updated, but ${result.sync.skipped.join("; ")}.`
            : "Resident updated — application, lease and charges rebuilt.",
        );
      })
      .finally(() => setErSaving(false));
  }

  function openResidentPaymentSettings() {
    if (!selected) return;
    const propId = selected.propertyId.trim();
    if (!propId) {
      showToast("This resident isn't linked to a property yet.");
      return;
    }
    setResidentPaymentSettingsOpen(true);
  }

  /**
   * Whether this resident exists ONLY in the browser — absent from the manager's
   * own server-scoped applications list. A read failure answers `false`, so an
   * unreachable server never turns into permission to delete.
   */
  async function residentIsLocalOnly(resident: ActiveResident): Promise<boolean> {
    try {
      const res = await fetch("/api/manager-applications", { credentials: "include" });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { rows?: { id?: string; email?: string }[] } | null;
      if (!Array.isArray(data?.rows)) return false;
      const email = resident.email.trim().toLowerCase();
      return !data.rows.some(
        (row) => row?.id === resident.id || (email.length > 0 && row?.email?.trim().toLowerCase() === email),
      );
    } catch {
      return false;
    }
  }

  /**
   * Ask the server what a Delete would remove, without removing it. Returns null
   * when the count cannot be read — the dialog then holds Delete instead of
   * implying the resident has nothing linked to them.
   */
  async function previewResidentDelete(resident: ActiveResident): Promise<ResidentDeleteCounts | null> {
    try {
      const res = await fetch("/api/portal/delete-resident-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode: "preview", email: resident.email, applicationId: resident.id }),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { counts?: unknown } | null;
      return body?.counts ? readResidentDeleteCounts(body.counts) : null;
    } catch {
      return null;
    }
  }

  async function loadResidentDeletePreview(residents: ActiveResident[]) {
    if (residents.length === 0) {
      setBulkDeletePreview(EMPTY_RESIDENT_DELETE_PREVIEW);
      return;
    }
    setBulkDeletePreview({ loading: true, counts: null, error: null });
    let total = emptyResidentDeleteCounts();
    for (const resident of residents) {
      const counts = await previewResidentDelete(resident);
      if (!counts) {
        setBulkDeletePreview({
          loading: false,
          counts: null,
          error: "Couldn't read what is linked to this resident. Try again.",
        });
        return;
      }
      total = addResidentDeleteCounts(total, counts);
    }
    setBulkDeletePreview({ loading: false, counts: total, error: null });
  }

  /**
   * Delete one resident from this portfolio. The server removes the application
   * AND every lease, charge, service, inspection, document and conversation
   * linked to them in one transaction, so this waits for its answer and reports
   * the counts it actually removed. It used to fire its own lease / service /
   * charge deletes and ignore the replies — the lease endpoint refuses a signed
   * lease, so every booking bar survived a "Deleted … and all related portal
   * data" toast.
   */
  async function executeResidentDelete(
    selectedResident: ActiveResident,
  ): Promise<{ ok: true; removed: ResidentDeleteCounts } | { ok: false }> {
    const allRows = readManagerApplicationRows();
    if (!allRows.some((row) => row.id === selectedResident.id)) {
      showToast("Resident not found.");
      return { ok: false };
    }

    let serverDeleteError: string | null = null;
    let removed = emptyResidentDeleteCounts();
    try {
      const res = await fetch("/api/portal/delete-resident-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: selectedResident.email,
          purgeData: true,
          applicationId: selectedResident.id,
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; removed?: unknown } | null;
      if (!res.ok) {
        serverDeleteError = body?.error ?? "Could not delete resident.";
      } else {
        removed = readResidentDeleteCounts(body?.removed);
      }
    } catch {
      serverDeleteError = "Could not delete resident.";
    }

    if (serverDeleteError) {
      /*
        A record the server has never seen is refused the same way one belonging
        to another manager is — the route cannot say which without becoming an
        oracle for whether an address has an account. That left a resident that
        only ever existed in this browser (added offline, or never mirrored)
        stuck in the list forever, refusing every Delete with "not in your
        portfolio". So ask the manager's OWN server-side list: if the row is not
        there either, there is nothing on the server to protect, and clearing the
        local copy is the whole job. Anything the server does know about keeps
        its refusal.
      */
      if (!(await residentIsLocalOnly(selectedResident))) {
        showToast(serverDeleteError);
        return { ok: false };
      }
    }

    writeManagerApplicationRows(allRows.filter((row) => row.id !== selectedResident.id));

    /*
      Everything below only clears this BROWSER's mirror of rows the server has
      already removed, so Bookings, Payments, Services and Communication agree
      with the database before the next sync lands. None of it is the delete.
    */
    const residentEmail = selectedResident.email.trim().toLowerCase();
    removeResidentHouseholdPaymentData(selectedResident.email);

    const residentLeases = readLeasePipeline(userId).filter(
      (row) => row.residentEmail.trim().toLowerCase() === residentEmail,
    );
    if (residentLeases.length > 0) {
      deleteLeasePipelineRowsForResident(selectedResident.email, selectedResident.id, userId);
    }

    const residentWorkOrders = readManagerWorkOrderRows().filter(
      (row) => row.residentEmail?.trim().toLowerCase() === residentEmail,
    );
    for (const workOrder of residentWorkOrders) {
      deleteManagerWorkOrderRow(workOrder.id);
    }

    deleteServiceRequestsForResident(selectedResident.email);
    clearUploadedOwnLease(selectedResident.email);

    const allInbox = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []);
    persistInbox(
      MANAGER_INBOX_STORAGE_KEY,
      allInbox.filter((thread) => thread.email.trim().toLowerCase() !== residentEmail),
    );

    await syncManagerApplicationsFromServer({ force: true, managerUserId: userId });
    setHcTick((n) => n + 1);
    setLeaseTick((n) => n + 1);
    setWorkOrderTick((n) => n + 1);
    setInboxTick((n) => n + 1);
    return { ok: true, removed };
  }

  /**
   * The ticked rows, in the order the list shows them. Delete names every one of
   * them before it runs — the objection to putting Delete on a bulk bar was that
   * the bar says nothing about who is about to go, and a confirmation that lists
   * them is what answers it.
   */
  const listSelectedResidents = useMemo(
    () => residentDirectoryRows.filter((row) => selectedIds.has(row.id)),
    [residentDirectoryRows, selectedIds],
  );

  async function deleteSelectedResidents() {
    if (listSelectedResidents.length === 0) return;
    setBulkDeleteBusy(true);
    let deleted = 0;
    let removed = emptyResidentDeleteCounts();
    const deletedNames: string[] = [];
    const failed: string[] = [];
    try {
      // Serial on purpose: each delete rewrites the same local application,
      // lease and inbox stores, so overlapping runs would race each other's
      // read-modify-write and leave rows behind.
      for (const resident of listSelectedResidents) {
        const result = await executeResidentDelete(resident);
        if (result.ok) {
          deleted += 1;
          removed = addResidentDeleteCounts(removed, result.removed);
          deletedNames.push(resident.name || resident.email || resident.id);
        } else failed.push(resident.name || resident.email || resident.id);
      }
    } finally {
      setBulkDeleteBusy(false);
    }
    setBulkDeleteOpen(false);
    setBulkDeletePreview(EMPTY_RESIDENT_DELETE_PREVIEW);
    clearSelection();
    if (activeResidentId && listSelectedResidents.some((row) => row.id === activeResidentId)) {
      navigate(`${portalBase}/residents/${residentsTab}`);
    }
    if (deleted > 0) {
      // Name what actually went. A count of rows the server confirms is the only
      // honest version of the old "and all related portal data".
      const subject = deleted === 1 ? deletedNames[0] : `${deleted} residents`;
      const linked = describeResidentDeleteCounts(removed);
      showToast(
        failed.length > 0
          ? `Deleted ${subject}; ${failed.length} could not be deleted.`
          : linked
            ? `Deleted ${subject} · ${linked}.`
            : `Deleted ${subject}.`,
      );
    } else if (failed.length > 0) {
      // Never finish a destructive action in silence: each attempt already
      // toasted its own reason, but a run that deleted nothing must say so. The
      // delete is one transaction, so a failure left every linked row in place.
      showToast(
        failed.length === 1
          ? `Couldn't delete ${failed[0]}. Nothing was removed. Try again.`
          : `Couldn't delete any of the ${failed.length} selected residents. Nothing was removed.`,
      );
    }
  }

  /**
   * Delete the resident the Edit modal is open on. Separate from the list's
   * bulk delete: this one knows exactly which record it is destroying, names it
   * in the confirmation, and closes the modal it was invoked from.
   */
  async function deleteEditedResident() {
    const targetId = editResidentTargetId;
    if (!targetId) return;
    const resident = residentDirectoryRows.find((row) => row.id === targetId);
    if (!resident) {
      showToast("Resident record not found.");
      return;
    }
    const label = resident.name || resident.email || "this resident";
    if (!(await confirm({ description: `Delete ${label}? This cannot be undone.` }))) return;
    const result = await executeResidentDelete(resident);
    if (!result.ok) return;
    setEditResidentOpen(false);
    setEditResidentTargetId(null);
    clearSelection();
    if (activeResidentId === targetId) {
      navigate(`${portalBase}/residents/${residentsTab}`);
    }
    const linked = describeResidentDeleteCounts(result.removed);
    showToast(linked ? `Deleted ${label} · ${linked}.` : `Deleted ${label}.`);
  }

  const generateLeaseRow = regenerateConfirmLeaseId
    ? readLeasePipeline(userId).find((r) => r.id === regenerateConfirmLeaseId) ?? null
    : null;

  function signLeaseAsManager(row: LeasePipelineRow) {
    if (!leaseAwaitingManagerCountersign(row)) {
      showToast("The resident must sign the lease before you can countersign.");
      return;
    }
    setSigningLease(row);
  }

  async function handleManagerModalSign(signatureName: string, consentVersion: string) {
    if (!signingLease) return false;
    setSigningLeaseError(null);
    const result = await managerSignLease(signingLease.id, signatureName.trim(), userId, consentVersion);
    if (result.ok) {
      setLeaseTick((n) => n + 1);
      const fullySigned = hasBothLeaseSignatures({
        ...signingLease,
        managerSignature: { role: "manager", name: signatureName.trim(), signedAtIso: new Date().toISOString() },
      });
      // The last signature just landed: payments are created now, from the signed terms.
      let paymentsScheduled = false;
      if (fullySigned && !signingLease.pendingRenewal) {
        const executed = readLeasePipeline(userId).find((r) => r.id === signingLease.id);
        if (executed) {
          const made = await createChargesForExecutedLease(executed, userId ?? null).catch(() => null);
          paymentsScheduled = Boolean(made && made.ok && made.created);
          if (paymentsScheduled) setHcTick((n) => n + 1);
        }
      }
      showToast(
        fullySigned
          ? paymentsScheduled
            ? "Lease fully signed. Payments are scheduled."
            : "Lease fully signed."
          : "Manager signature saved.",
      );
      setSigningLease(null);
      return true;
    } else {
      // Signing waits for the server: the modal stays open and shows why.
      setSigningLeaseError(result.error);
      return false;
    }
  }

  /** The one ⋯ on a resident service row: Edit first (opens the service), Delete last. */
  const residentServiceRowMenu = ({
    label,
    onEdit,
    onDelete,
  }: {
    label: string;
    onEdit: () => void;
    onDelete: () => void;
  }) => (
    <span className="shrink-0" data-portal-row-ignore onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <span>
            <PortalIconAction
              icon={MoreHorizontal}
              label={`Actions for ${label}`}
              data-attr="resident-service-row-actions"
            />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-attr="resident-service-row-edit" onSelect={onEdit}>
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem data-attr="resident-service-row-delete" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );

  const deleteResidentServiceItem = async (item: { kind: "request" | "work-order"; id: string; label: string }) => {
    if (!(await confirm({ description: `Delete "${item.label}"?` }))) return;
    if (item.kind === "request") {
      deleteServiceRequest(item.id);
      setSrTick((n) => n + 1);
      showToast("Service removed.");
      return;
    }
    if (deleteManagerWorkOrderRow(item.id)) {
      setWorkOrderTick((n) => n + 1);
      showToast("Service removed.");
    } else {
      showToast("Could not delete service.");
    }
  };

  const residentServicesAddRow = (
    <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
      <PortalListAddRow
        label="Add service"
        ariaLabel="Add service for this resident"
        icon={PORTAL_LIST_ADD_ICONS.service}
        disabled={!canAddResidentServiceItem}
        hint={
          canAddResidentServiceItem
            ? undefined
            : "Link this resident to a property before adding services."
        }
        onClick={() => setAddResidentServiceOpen(true)}
        dataAttr="resident-add-service"
      />
    </div>
  );

  useEffect(() => {
    if (resolvedDetailTab !== "payments") {
      setEmbeddedPaymentBulkActions(null);
    }
  }, [resolvedDetailTab]);

  const residentPaymentsListHref = selected
    ? residentDetailHref(portalBase, residentsTab, selected.id, "payments")
    : undefined;

  const residentToursListHref = selected
    ? managerResidentTourListHref(portalBase, residentsTab, selected.id, tourBucketProp)
    : undefined;

  const residentServicesListHref = selected
    ? residentDetailHref(portalBase, residentsTab, selected.id, "services")
    : undefined;

  const residentDetailItemBackHref =
    paymentIdProp && residentPaymentsListHref
      ? residentPaymentsListHref
      : tourIdProp && residentToursListHref
        ? residentToursListHref
        : serviceItemIdProp && residentServicesListHref
          ? residentServicesListHref
          : `${portalBase}/residents/${residentsTab}`;

  const residentDetailItemBackLabel = paymentIdProp
    ? "Back to payments"
    : tourIdProp
      ? "Back to tours"
      : serviceItemIdProp
        ? "Back to services"
        : "Back to residents";

  const residentDetailViewportFill =
    resolvedDetailTab === "communication" ||
    resolvedDetailTab === "tours" ||
    (showResidentApplication &&
      (resolvedDetailTab === "application" || resolvedDetailTab === "background-check"));

  const residentDetailPaymentsScroll =
    Boolean(residentIdProp && selected && resolvedDetailTab === "payments");

  const residentDetailInternalScroll =
    residentDetailViewportFill || residentDetailPaymentsScroll;

  const residentDetailScrollBodyPadding =
    "pb-[calc(3.5rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))]";

  /**
   * The rail, phone chip strip, and sticky primary action all come from the
   * registry now (PLAN-0920-1058, area 1a — docs/agents/record-page.md). A
   * resident's own sections are filtered to what this stage actually offers;
   * the shared trio (Communication always, Documents/Activity here too) is
   * never filtered. "Send setup" has no registry action id — it is appended
   * only while this resident has no portal account yet, so it reaches both
   * the desktop icon row and the phone sticky overflow from one list.
   */
  const residentLifecycleInput = useMemo((): ResidentLifecycleInput | null => {
    if (!selected) return null;
    return {
      directoryStage: selected.stage,
      application: selectedApplicationRow,
      leaseRows: residentLeaseRows,
      ledgerRows: residentLedgerRows,
      hasPortalAccount: selectedHasPortalAccount,
      roomLabel: selected.roomLabel,
      propertyLabel: selected.propertyLabel,
      moveInDate: selected.leaseStart,
      moveOutDate: selected.leaseEnd,
      signedMonthlyRent: selected.signedMonthlyRent,
      screeningRequested: Boolean(selectedApplicationRow?.screening),
    };
  }, [
    selected,
    selectedApplicationRow,
    residentLeaseRows,
    residentLedgerRows,
    selectedHasPortalAccount,
  ]);

  const residentRecordSubtitle = useMemo(() => {
    if (!selected || !residentLifecycleInput) {
      return [selected?.propertyLabel, selected?.roomLabel].filter(Boolean).join(" · ") || selected?.email || "";
    }
    const hrefs = {
      application: residentDetailHref(portalBase, residentsTab, selected.id, "application"),
      backgroundCheck: residentDetailHref(portalBase, residentsTab, selected.id, "background-check"),
      lease: residentDetailHref(portalBase, residentsTab, selected.id, "lease"),
      payments: residentDetailHref(portalBase, residentsTab, selected.id, "payments"),
      tours: managerResidentTourListHref(portalBase, residentsTab, selected.id, tourBucketProp),
      inspections: residentRecordMoveInHref(portalBase, residentsTab, selected.id, "inspections"),
      services: residentDetailHref(portalBase, residentsTab, selected.id, "services"),
    };
    const lifecycle = buildResidentLifecycle(residentLifecycleInput, hrefs);
    const place = [selected.propertyLabel, selected.roomLabel].filter(Boolean).join(" · ");
    const stageLine = residentHeaderStageLine(lifecycle);
    return place ? `${stageLine}\n${place}` : stageLine;
  }, [portalBase, residentsTab, selected, residentLifecycleInput, tourBucketProp]);

  const residentRecordHeaderActions = useMemo(() => {
    const sections = recordSections("manager", "resident", { basePath: portalBase, residentsTab });
    // Send application · Send lease · Upload for resident sit with the record's other leasing actions,
    // ahead of Delete (which stays last).
    const sendActions = [
      { id: "send-application", label: "Send application", icon: Send },
      { id: "send-lease", label: "Send lease", icon: ScrollText },
      { id: "upload-for-resident", label: "Upload for resident", icon: Upload },
    ];
    const deleteAt = sections.headerActions.findIndex((action) => action.id === "delete");
    const base = deleteAt === -1
      ? [...sections.headerActions, ...sendActions]
      : [...sections.headerActions.slice(0, deleteAt), ...sendActions, ...sections.headerActions.slice(deleteAt)];
    const withSetup = selectedHasPortalAccount
      ? base
      : [...base, { id: "setup", label: "Send setup", icon: Mail }];
    return withSetup;
  }, [portalBase, residentsTab, selectedHasPortalAccount]);

  /**
   * The icon actions of the open tab's section header card. Header actions at the top right never
   * change with the tab; everything tab-specific lives here, in the tab's own header.
   */
  const residentSectionHeaderActions = useMemo((): RecordHeaderAction[] => {
    const sections = recordSections(
      "manager",
      "resident",
      { basePath: portalBase, residentsTab },
      resolvedDetailTab,
    );
    let actions = sections.headerActions;
    if (resolvedDetailTab === "application") {
      // Every application action, as icons: what applies follows the application's state — a
      // pending one can be approved or rejected, a decided one can be moved back, an unfinished one
      // can be chased. The blue + sends an application.
      const row = selectedApplicationRow;
      const next: RecordHeaderAction[] = [];
      if (row) {
        const undecidable = isWithdrawnApplicationRow(row) || isInProgressApplicationRow(row);
        if (shouldOfferApplicationCompletionReminder(row)) {
          next.push({ id: "remind-application", label: "Send reminder", icon: Bell });
        }
        if (row.bucket === "pending" && !undecidable) {
          next.push({ id: "approve", label: "Approve", icon: CheckCircle2 });
          next.push({ id: "decline", label: "Reject", icon: XCircle, tone: "danger" });
        }
        if (row.application) next.push({ id: "edit", label: "Edit", icon: Pencil });
        next.push({ id: "download", label: "Download PDF", icon: Download });
      }
      next.push({ id: "send-application", label: "Add application", icon: Send, tone: "primary" });
      return next;
    }
    if (resolvedDetailTab === "background-check") {
      if (selectedApplicationRow?.screening) {
        actions = actions.filter((a) => a.id !== "run-check");
      }
      // Chase the applicant when they have not authorized a check yet (there is nothing to run).
      if (
        selectedApplicationRow &&
        applicationShowsBackgroundCheck(selectedApplicationRow) &&
        !selectedApplicationRow.application?.consentCredit &&
        shouldOfferApplicationCompletionReminder(selectedApplicationRow)
      ) {
        actions = [{ id: "remind-application", label: "Send reminder", icon: Bell }, ...actions];
      }
    }
    if (
      resolvedDetailTab === "lease" &&
      residentLease &&
      residentLease.status !== "Resident Signature Pending" &&
      residentLease.status !== "Manager Signature Pending"
    ) {
      actions = actions.filter((a) => a.id !== "remind-sign");
    }
    if (resolvedDetailTab === "payments") {
      const hasUnpaid = residentLedgerRows.some((r) => r.bucket === "overdue" || r.bucket === "pending");
      if (!hasUnpaid) {
        actions = actions.filter((a) => a.id !== "remind-payment");
      }
    }
    return actions;
  }, [
    portalBase,
    residentsTab,
    resolvedDetailTab,
    selectedApplicationRow,
    residentLease,
    residentLedgerRows,
  ]);

  const residentSections = useMemo(() => {
    const sections = recordSections("manager", "resident", { basePath: portalBase, residentsTab });
    return {
      ...sections,
      headerActions: residentRecordHeaderActions,
      groups: sections.groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => residentDetailTabsAvailable.includes(item.id as ResidentDetailTabId)),
        }))
        .filter((group) => group.items.length > 0),
    };
  }, [portalBase, residentDetailTabsAvailable, residentsTab, residentRecordHeaderActions]);

  const residentOverviewServices = useMemo((): ResidentOverviewServiceItem[] => {
    if (!selected) return [];
    const requests: ResidentOverviewServiceItem[] = residentServiceRequests.map((req) => ({
      id: `request-${req.id}`,
      title: req.offerName,
      detail: managerServiceRequestPricingSummary(req),
      bucket: residentUnifiedServiceBucketForRequest(req),
      href: managerResidentItemDetailHref(portalBase, residentsTab, selected.id, "services", `request-${req.id}`),
    }));
    const workOrders: ResidentOverviewServiceItem[] = residentWorkOrders.map((row) => ({
      id: `work-order-${row.id}`,
      title: row.title,
      detail: [row.scheduled?.trim(), row.status?.trim()].filter(Boolean).join(" · ") || "Service",
      bucket: residentUnifiedServiceBucketForWorkOrder(row),
      href: managerResidentItemDetailHref(portalBase, residentsTab, selected.id, "services", `work-order-${row.id}`),
    }));
    const order = { pending: 0, scheduled: 1, completed: 2 } as const;
    return [...requests, ...workOrders].sort((a, b) => order[a.bucket] - order[b.bucket]);
  }, [portalBase, residentServiceRequests, residentWorkOrders, residentsTab, selected]);

  const residentOverviewLinks = useMemo(() => {
    if (!selected) return {};
    const has = (tab: ResidentDetailTabId) => residentDetailTabsAvailable.includes(tab);
    const href = (tab: ResidentDetailTabId) => residentDetailHref(portalBase, residentsTab, selected.id, tab);
    return {
      payments: href("payments"),
      lease: href("lease"),
      application: href("application"),
      services: has("services") ? href("services") : undefined,
      communication: href("communication"),
      tours: managerResidentTourListHref(portalBase, residentsTab, selected.id, tourBucketProp),
      backgroundCheck: href("background-check"),
      inspections: residentRecordMoveInHref(portalBase, residentsTab, selected.id, "inspections"),
    };
  }, [portalBase, residentDetailTabsAvailable, residentsTab, selected, tourBucketProp]);

  // Wires the phone sticky action (and its ⋯ overflow) from
  // PortalRecordSectionChrome to the SAME handlers the desktop icon row
  // calls — real functionality where it exists, "Coming soon" otherwise
  // (docs/agents/record-page.md § Known gap).
  const onResidentRecordHeaderAction = (actionId: string) => {
    if (!selected) return;
    switch (actionId) {
      case "message":
        setMessageOpen(true);
        return;
      case "edit":
        openEditResidentModal(selected.id);
        return;
      case "share":
        void navigator.clipboard?.writeText(window.location.href);
        showToast("Link copied");
        return;
      case "archive":
        showToast("Archive is not available for this resident yet.");
        return;
      case "delete":
        void (async () => {
          const resident = residentDirectoryRows.find((row) => row.id === selected.id);
          if (!resident) {
            showToast("Resident record not found.");
            return;
          }
          const label = resident.name || resident.email || "this resident";
          if (!(await confirm({ description: `Delete ${label}? This cannot be undone.` }))) return;
          const result = await executeResidentDelete(resident);
          if (!result.ok) return;
          navigate(`${portalBase}/residents/${residentsTab}`);
          const linked = describeResidentDeleteCounts(result.removed);
          showToast(linked ? `Deleted ${label} · ${linked}.` : `Deleted ${label}.`);
        })();
        return;
      case "setup":
        openResidentEmailSetup(selected);
        return;
      case "send-application":
        setSendApplicationOpen(true);
        return;
      case "send-lease":
        if (!selectedApplicationRow) {
          showToast("This resident has no application to send a lease from.");
          return;
        }
        openSendLeaseForApplication(selectedApplicationRow.id);
        return;
      case "upload-for-resident":
        setUploadForResidentOpen(true);
        return;
      default:
        showToast("Coming soon");
    }
  };

  const onResidentSectionHeaderAction = (actionId: string) => {
    if (!selected) return;
    switch (actionId) {
      case "edit":
        if (resolvedDetailTab === "application" && selectedApplicationRow?.application) {
          setApplicationEditInitialStep(undefined);
          setApplicationEditOpen(true);
        } else {
          openEditResidentModal(selected.id);
        }
        return;
      case "upload":
        setResidentUploadKindPreset(
          resolvedDetailTab === "documents"
            ? "other"
            : resolvedDetailTab === "lease"
              ? "lease"
              : resolvedDetailTab === "background-check"
                ? "other"
                : "other",
        );
        setResidentUploadOpen(true);
        return;
      case "add-charge":
        setAddResidentPaymentOpen(true);
        return;
      case "add-service":
        if (!canAddResidentServiceItem) {
          showToast("Link this resident to a property before adding services.");
          return;
        }
        setAddResidentServiceOpen(true);
        return;
      case "add-tour":
        navigate(managerResidentTourListHref(portalBase, residentsTab, selected.id, tourBucketProp));
        return;
      case "add-inspection":
        navigate(residentRecordMoveInHref(portalBase, residentsTab, selected.id, "inspections"));
        return;
      case "approve":
        if (selectedApplicationRow) setApprovePreviewRow(selectedApplicationRow);
        return;
      case "decline":
        if (selectedApplicationRow) void declineApplicationRow(selectedApplicationRow);
        return;
      case "download":
        if (resolvedDetailTab === "application" && selectedApplicationRow) {
          runApplicationPdfDownload(selectedApplicationRow, showToast);
        } else if (resolvedDetailTab === "lease" && residentLease) {
          runLeaseDownload(residentLease, showToast);
        } else {
          showToast("Download will be available from the document preview.");
        }
        return;
      case "run-check":
        if (selectedApplicationRow) {
          setCheckrScreeningShowPicker(true);
          setCheckrScreeningRowId(selectedApplicationRow.id);
        }
        return;
      case "send-lease":
        if (residentLease && selected) openLeaseSendPreview(selected, residentLease);
        return;
      case "remind-sign":
        if (residentLease) openLeaseSigningReminderPreview(selected, residentLease);
        return;
      case "remind-payment":
        setMessageReminderForPayment(true);
        setMessageOpen(true);
        return;
      case "remind-application":
        if (selectedApplicationRow) void openApplicationCompletionReminderPreview(selectedApplicationRow);
        return;
      case "send-application":
        setSendApplicationOpen(true);
        return;
      default:
        showToast("Coming soon");
    }
  };

  const handleResidentUploadComplete = useCallback(
    async (files: File[], kinds: ResidentUploadDocKind[]) => {
      if (!selected) return;
      const email = selected.email?.trim();
      if (!email) {
        showToast("This resident has no email — upload could not be saved.");
        throw new Error("missing email");
      }
      let uploaded = 0;
      for (let i = 0; i < files.length; i++) {
        await uploadManagerDocumentForResident(files[i]!, kinds[i] ?? kinds[0] ?? "other", {
          residentEmail: email,
          propertyId: selected.propertyId,
          leaseId: residentLease?.id,
        });
        uploaded += 1;
      }
      setResidentDocsTick((n) => n + 1);
      const primaryKind = kinds[0] ?? "other";
      const review =
        primaryKind === "lease" || primaryKind === "application" ? " Review details in Documents." : "";
      showToast(`${uploaded} file${uploaded === 1 ? "" : "s"} added to Documents.${review}`);
      navigate(residentDetailHref(portalBase, residentsTab, selected.id, "documents"));
    },
    [navigate, portalBase, residentLease?.id, residentsTab, selected, showToast],
  );

  useEffect(() => {
    const email = selected?.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setResidentUploadedDocs([]);
      return;
    }
    let cancelled = false;
    void fetch("/api/manager-documents?scope=resident", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const rows = (data.documents ?? []) as ManagerDocumentDTO[];
        setResidentUploadedDocs(
          rows.filter((doc) => (doc.scope.residentEmail ?? "").trim().toLowerCase() === email),
        );
      })
      .catch(() => {
        if (!cancelled) setResidentUploadedDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.email, residentDocsTick]);

  const residentDocumentSections = useMemo(() => {
    const sections: Partial<Record<ManagerResidentDocTabId, import("@/components/portal/manager-resident-documents-panel").ManagerResidentDocumentRow[]>> =
      {};
    if (selectedApplicationRow?.application) {
      sections.application = [
        {
          id: `app-${selectedApplicationRow.id}`,
          name: "Application",
          date: undefined,
          generated: true,
        },
      ];
    }
    if (residentLease) {
      sections.lease = [
        {
          id: residentLease.id,
          name: selected?.propertyLabel?.trim() || "Lease agreement",
          date: residentLease.fullySignedAt ?? residentLease.sentToResidentAt ?? undefined,
          generated: true,
        },
      ];
    }
    const receipts = residentLedgerRows
      .filter((r) => r.bucket === "paid")
      .slice(0, 8)
      .map((r) => ({
        id: r.id,
        name: r.chargeTitle,
        date: r.dueDate,
        generated: false,
      }));
    if (receipts.length) sections.payments = receipts;

    const pushDoc = (tab: ManagerResidentDocTabId, row: import("@/components/portal/manager-resident-documents-panel").ManagerResidentDocumentRow) => {
      sections[tab] = [...(sections[tab] ?? []), row];
    };
    for (const doc of residentUploadedDocs) {
      const tab: ManagerResidentDocTabId =
        doc.category === "lease"
          ? "lease"
          : doc.category === "inspection"
            ? "inspections"
            : doc.category === "invoice"
              ? "payments"
              : "other";
      pushDoc(tab, {
        id: doc.id,
        name: doc.displayName,
        date: doc.createdAt?.slice(0, 10),
        generated: false,
      });
    }
    return sections;
  }, [residentLease, residentLedgerRows, residentUploadedDocs, selectedApplicationRow, selected]);

  const residentDetailPanel =
    selected ? (
                          <PortalRecordSectionChrome
                            sections={residentSections}
                            recordId={selected.id}
                            activeId={resolvedDetailTab}
                            title={selected.name || "Resident"}
                            subtitle={residentRecordSubtitle}
                            backHref={residentListHref(portalBase, residentsTab)}
                            backLabel="All residents"
                            ariaLabel="Resident profile sections"
                            onHeaderAction={onResidentRecordHeaderAction}
                          >
                          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-0">
                            <PortalPageChrome>
                              <div
                                className="border-b border-border/40 bg-background lg:hidden"
                                data-portal-property-detail-chrome
                              />
                            </PortalPageChrome>

                            {resolvedDetailTab === "overview" ? (
                              <ResidentDetailTabPanel>
                                <ResidentOverviewPanel
                                  resident={{
                                    name: selected.name,
                                    email: selected.email,
                                    phone:
                                      selected.manualResidentDetails?.phone?.trim() ||
                                      selectedApplicationRow?.application?.phone?.trim() ||
                                      undefined,
                                    propertyLabel: selected.propertyLabel,
                                    roomLabel: selected.roomLabel,
                                    signedMonthlyRent: selected.signedMonthlyRent,
                                    leaseStart: selected.leaseStart,
                                    leaseEnd: selected.leaseEnd,
                                    stage: selected.stage,
                                    statusLabel: selected.statusLabel,
                                    axisId: selected.axisId,
                                    moveInInstructions: selected.moveInInstructions,
                                  }}
                                  ledgerRows={residentLedgerRows}
                                  leaseRows={residentLeaseRows}
                                  services={residentOverviewServices}
                                  links={residentOverviewLinks}
                                  lifecycleInput={residentLifecycleInput ?? undefined}
                                  onNavigate={(href) => navigate(href)}
                                  onInlineAction={(actionId) => {
                                    if (actionId === "send-setup") openResidentEmailSetup(selected);
                                    if (actionId === "run-background-check" && selectedApplicationRow) {
                                      setCheckrScreeningShowPicker(true);
                                      setCheckrScreeningRowId(selectedApplicationRow.id);
                                    }
                                  }}
                                  onNextAction={(actionId) => {
                                    if (actionId === "approve-application" && selectedApplicationRow) {
                                      setApprovePreviewRow(selectedApplicationRow);
                                    } else if (actionId === "send-lease") {
                                      if (residentLease) openLeaseSendPreview(selected, residentLease);
                                      else openSendLeaseForApplication(selectedApplicationRow?.id ?? selected.id);
                                    } else if (actionId === "sign-lease" && residentLease) {
                                      signLeaseAsManager(residentLease);
                                    } else if (actionId === "remind-sign" && residentLease) {
                                      openLeaseSigningReminderPreview(selected, residentLease);
                                    }
                                  }}
                                  onCopyField={(label, value) => {
                                    void navigator.clipboard?.writeText(value);
                                    showToast(`${label} copied`);
                                  }}
                                  extraNeedsYou={moveInNeedsYou}
                                />
                              </ResidentDetailTabPanel>
                            ) : resolvedDetailTab === "move-in" ? (
                              <ResidentDetailTabPanel>
                                <ResidentRecordMoveInSection
                                  userId={userId ?? ""}
                                  applicationId={selectedApplicationRow?.id ?? selected.id}
                                  residentName={selected.name}
                                  residentEmail={selected.email}
                                  propertyId={selected.propertyId}
                                  basePath={portalBase}
                                  subTab={residentMoveInSubTab}
                                  onSubTabChange={(tab: ResidentMoveInTabId) =>
                                    navigate(residentRecordMoveInHref(portalBase, residentsTab, selected.id, tab))
                                  }
                                  placement={{
                                    propertyLabel: selected.propertyLabel,
                                    roomLabel: selected.roomLabel,
                                    moveInDate: selected.leaseStart,
                                    moveOutDate: selected.leaseEnd,
                                  }}
                                />
                              </ResidentDetailTabPanel>
                            ) : resolvedDetailTab === "communication" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              <ManagerResidentSectionToolbar
                                title="Communication"
                                actions={[]}
                                onAction={onResidentSectionHeaderAction}
                              />
                              <ManagerResidentDetailInbox
                                residentEmail={selected.email}
                                residentName={selected.name}
                                portalBase={portalBase}
                                smsUiEnabled={smsUiEnabled}
                                scheduledRefreshKey={messageScheduledRefresh}
                              />
                            </ResidentDetailTabPanel>
                            </div>
                            ) : showResidentLease && resolvedDetailTab === "lease" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              <ManagerResidentSectionToolbar
                                title="Lease"
                                actions={residentSectionHeaderActions}
                                onAction={onResidentSectionHeaderAction}
                                destinationRow={
                                  <LocalDestinationNav
                                    items={RESIDENT_DETAIL_LEASE_PIPELINE_TABS.map((tab) => ({
                                      id: tab.id,
                                      label: tab.label,
                                      count: residentLeasePipelineCounts[tab.id],
                                      dataAttr: tab.dataAttr,
                                    }))}
                                    activeId={residentLeasePipelineTab}
                                    onChange={(id) => setResidentLeasePipelineTab(id as LeaseListTabId)}
                                    ariaLabel="Lease status"
                                    appearance="command"
                                    className="w-full"
                                  />
                                }
                              />
                              {residentLease ? (
                                <div className="flex min-h-0 flex-1 flex-col gap-3">
                                  <LeaseSignersCard row={residentLease} />
                                  <LeaseDocumentPreview
                                    row={residentLease}
                                    flow
                                    suppressApplicationDraft={Boolean(selected.manuallyAdded)}
                                    emptyHint="No lease document yet. Generate or upload one from Manager Review first."
                                  />
                                </div>
                              ) : residentLeaseRows.length > 0 ? (
                                <p className="text-sm text-muted">
                                  No {RESIDENT_DETAIL_LEASE_PIPELINE_TABS.find((tab) => tab.id === residentLeasePipelineTab)?.label.toLowerCase()} lease.
                                </p>
                              ) : (
                                <p className="text-sm text-muted">
                                  {selectedApplicationRow?.bucket === "approved"
                                    ? "Add or upload a lease from the Leases section."
                                    : "Approve the application first, then add a lease from the Leases section."}
                                </p>
                              )}
                            </ResidentDetailTabPanel>
                            </div>
                            ) : showResidentApplication && resolvedDetailTab === "background-check" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              <ManagerResidentSectionToolbar
                                title="Background check"
                                actions={residentSectionHeaderActions}
                                onAction={onResidentSectionHeaderAction}
                                destinationRow={
                                  <LocalDestinationNav
                                    items={RESIDENT_DETAIL_BACKGROUND_CHECK_BUCKET_TABS.map((tab) => ({
                                      id: tab.id,
                                      label: tab.label,
                                      count: residentBackgroundCheckBucketCounts[tab.id],
                                      dataAttr: tab.dataAttr,
                                    }))}
                                    activeId={residentBackgroundCheckBucket}
                                    onChange={(id) => setResidentBackgroundCheckBucket(id as ResidentRecordStatusBucketId)}
                                    ariaLabel="Background check status"
                                    appearance="command"
                                    className="w-full"
                                  />
                                }
                              />
                              {residentBackgroundCheckBucket !== selectedBackgroundCheckBucket ? (
                                <p className="text-sm text-muted">
                                  No {residentBackgroundCheckBucket} background check.
                                </p>
                              ) : selectedApplicationRow &&
                                applicationShowsBackgroundCheck(selectedApplicationRow) ? (
                                <ManagerResidentBackgroundCheckPanel row={selectedApplicationRow} />
                              ) : (
                                <p className="text-sm text-muted">No background check for this resident.</p>
                              )}
                            </ResidentDetailTabPanel>
                            </div>
                            ) : showResidentApplication && resolvedDetailTab === "application" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              <ManagerResidentSectionToolbar
                                title="Application"
                                actions={residentSectionHeaderActions}
                                onAction={onResidentSectionHeaderAction}
                                destinationRow={
                                  <LocalDestinationNav
                                    items={RESIDENT_DETAIL_APPLICATION_BUCKET_TABS.map((tab) => ({
                                      id: tab.id,
                                      label: tab.label,
                                      count: residentApplicationBucketCounts[tab.id],
                                      dataAttr: tab.dataAttr,
                                    }))}
                                    activeId={residentApplicationBucket}
                                    onChange={(id) => setResidentApplicationBucket(id as ResidentRecordStatusBucketId)}
                                    ariaLabel="Application status"
                                    appearance="command"
                                    className="w-full"
                                  />
                                }
                                overflowMenu={
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <span>
                                        <PortalIconAction
                                          icon={MoreHorizontal}
                                          label="More"
                                          data-attr="resident-application-more"
                                        />
                                      </span>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        data-attr="resident-application-upload-completed"
                                        onSelect={() => {
                                          setResidentUploadKindPreset("application");
                                          setResidentUploadOpen(true);
                                        }}
                                      >
                                        Upload completed application
                                      </DropdownMenuItem>
                                      {selectedApplicationRow &&
                                      (selectedApplicationRow.bucket === "approved" ||
                                        selectedApplicationRow.bucket === "rejected") ? (
                                        <DropdownMenuItem
                                          data-attr="resident-application-move-pending"
                                          onSelect={() => void setApplicationBucket(selectedApplicationRow.id, "pending")}
                                        >
                                          Move to pending
                                        </DropdownMenuItem>
                                      ) : null}
                                      {selectedApplicationRow?.bucket === "rejected" ? (
                                        <DropdownMenuItem
                                          data-attr="resident-application-delete"
                                          onSelect={() => void deleteApplicationForRow(selectedApplicationRow)}
                                        >
                                          Delete
                                        </DropdownMenuItem>
                                      ) : null}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                }
                              />
                              {residentApplicationBucket !== selectedApplicationBucket ? (
                                <p className="text-sm text-muted">
                                  No {residentApplicationBucket} application.
                                </p>
                              ) : selectedApplicationRow?.application ? (
                                activeCosignerSubmission ? (
                                  <ManagerCosignerReadonlyReview
                                    sub={activeCosignerSubmission}
                                    signerRow={selectedApplicationRow}
                                    onOpenSignerApplication={() =>
                                      navigate(
                                        residentDetailHref(portalBase, residentsTab, selected.id, "application"),
                                      )
                                    }
                                  />
                                ) : (
                                  <ManagerResidentApplicationFactCards
                                    row={selectedApplicationRow}
                                    assignedPropertyId={selected.propertyId}
                                    assignedRoomChoice={selected.roomLabel}
                                    onEditStep={(step) => {
                                      setApplicationEditInitialStep(step);
                                      setApplicationEditOpen(true);
                                    }}
                                  />
                                )
                              ) : (
                                <p className="text-sm text-muted">No application on file for this resident.</p>
                              )}
                            </ResidentDetailTabPanel>
                            </div>
                            ) : resolvedDetailTab === "tours" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              <ManagerResidentToursPanel
                                managerUserId={userId}
                                residentEmail={selected.email}
                                residentName={selected.name}
                                bucket={tourBucketProp}
                                tourId={tourIdProp}
                                propertyIds={managerPortfolioPropertyIds}
                                sectionToolbar={(destinationRow) => (
                                  <ManagerResidentSectionToolbar
                                    title="Tours"
                                    actions={residentSectionHeaderActions}
                                    onAction={onResidentSectionHeaderAction}
                                    destinationRow={destinationRow}
                                    overflowMenu={
                                      <ResidentDetailCommandToolbar
                                        onSettings={() => openResidentDetailSettings("tours")}
                                        settingsLabel={toursSettingsEntry.label}
                                        settingsDataAttr={toursSettingsEntry.dataAttr}
                                        onEdit={() => onResidentSectionHeaderAction("add-tour")}
                                      />
                                    }
                                  />
                                )}
                                buildTourListHref={
                                  selected
                                    ? (targetBucket) =>
                                        managerResidentTourListHref(
                                          portalBase,
                                          residentsTab,
                                          selected.id,
                                          targetBucket,
                                        )
                                    : undefined
                                }
                                buildTourDetailHref={
                                  selected
                                    ? (row) =>
                                        managerResidentTourDetailHref(
                                          portalBase,
                                          residentsTab,
                                          selected.id,
                                          row.bucket,
                                          row.id,
                                        )
                                    : undefined
                                }
                              />
                            </ResidentDetailTabPanel>
                            </div>
                            ) : (
                            <>

                            {resolvedDetailTab === "payments" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              {!paymentIdProp ? (
                                <ManagerResidentSectionToolbar
                                  title="Payments"
                                  actions={residentSectionHeaderActions}
                                  onAction={onResidentSectionHeaderAction}
                                  destinationRow={
                                    <LocalDestinationNav
                                      items={PAYMENT_BUCKETS.map((id) => ({
                                        id,
                                        label:
                                          id === "overdue"
                                            ? "Overdue"
                                            : id === "pending"
                                              ? "Pending"
                                              : "Paid",
                                        count: residentPaymentBucketCounts[id],
                                        dataAttr: `resident-payments-bucket-${id}`,
                                      }))}
                                      activeId={chargeBucket}
                                      onChange={(id: string) => setChargeBucket(id as ManagerPaymentBucket)}
                                      ariaLabel="Payment status"
                                      appearance="command"
                                      className="w-full"
                                    />
                                  }
                                  overflowMenu={
                                    <>
                                      {/* A selection's bulk actions live in this header card, not in the page's title row. */}
                                      {embeddedPaymentBulkActions}
                                      <PortalIconAction
                                        icon={SettingsIcon}
                                        label={paymentsSettingsEntry.label}
                                        data-attr={paymentsSettingsEntry.dataAttr}
                                        onClick={() => openResidentDetailSettings("payments")}
                                      />
                                      <PortalIconAction
                                        icon={Pencil}
                                        label="Edit"
                                        data-attr="resident-detail-edit"
                                        onClick={() => setResidentPaymentSettingsOpen(true)}
                                      />
                                    </>
                                  }
                                />
                              ) : embeddedPaymentFooterActions ? (
                                // One payment's own actions sit in the same header card, never in the page's title row.
                                <ManagerResidentSectionToolbar
                                  title="Payments"
                                  actions={[]}
                                  onAction={onResidentSectionHeaderAction}
                                  overflowMenu={embeddedPaymentFooterActions}
                                />
                              ) : null}
                              <PortalPageScrollBody
                                className={`min-w-0 max-w-full pt-0 ${residentDetailScrollBodyPadding}`}
                              >
                                <ManagerPaymentsLedgerPanel
                                  rows={paymentIdProp ? residentLedgerRows : residentLedgerRowsForBucket}
                                  managerUserId={userId ?? null}
                                  activeBucket={chargeBucket}
                                  scheduledMessages={scheduledPaymentMessages}
                                  reminderScheduleSummary={residentReminderScheduleSummary}
                                  reminderAutomationSettings={residentReminderSettings}
                                  onOpenReminderSettings={() => setResidentPaymentSettingsOpen(true)}
                                  onScheduleChanged={() => void reloadResidentPaymentSchedule()}
                                  onRowsChanged={() => {
                                    setHcTick((n) => n + 1);
                                    setLeaseTick((n) => n + 1);
                                  }}
                                  paymentId={paymentIdProp}
                                  listBasePath={residentPaymentsListHref}
                                  embeddedInResident
                                  buildPaymentDetailHref={
                                    selected
                                      ? (row) =>
                                          residentPaymentDetailHref(
                                            portalBase,
                                            residentsTab,
                                            selected.id,
                                            publicChargeIdForUrl(row.id),
                                          )
                                      : undefined
                                  }
                                  onEmbeddedDetailActions={handleEmbeddedPaymentFooterActions}
                                  onEmbeddedBulkActions={handleEmbeddedPaymentBulkActions}
                                  onAddPayment={() => setAddResidentPaymentOpen(true)}
                                />
                              </PortalPageScrollBody>
                            </ResidentDetailTabPanel>
                            </div>
                            ) : null}

                            {resolvedDetailTab === "services" ? (
                            <ResidentDetailTabPanel>
                              {serviceItemIdProp && residentServiceDetailItem ? (
                                residentServiceDetailItem.kind === "request" ? (
                                  <ManagerServiceRequestDetail
                                    req={residentServiceDetailItem.req}
                                    propertyLabel={selected.propertyLabel || "—"}
                                    onUpdated={() => setSrTick((n) => n + 1)}
                                    onApproved={() => setResidentServicesBucket("scheduled")}
                                    onDenied={() => setResidentServicesBucket("completed")}
                                    onCollapsed={() => {
                                      if (residentServicesListHref) navigate(residentServicesListHref);
                                    }}
                                  />
                                ) : (
                                  <div className="space-y-2 px-3 py-2 text-sm text-muted sm:px-4">
                                    {residentServiceDetailItem.row.description?.trim() ? (
                                      <p className="text-foreground">
                                        {residentServiceDetailItem.row.description.trim()}
                                      </p>
                                    ) : null}
                                    {residentServiceDetailItem.row.scheduled?.trim() ? (
                                      <p>Scheduled: {residentServiceDetailItem.row.scheduled}</p>
                                    ) : null}
                                    {residentServiceDetailItem.row.priority?.trim() ? (
                                      <p>Priority: {residentServiceDetailItem.row.priority}</p>
                                    ) : null}
                                    {residentServiceDetailItem.row.cost?.trim() ? (
                                      <p>Cost: {residentServiceDetailItem.row.cost}</p>
                                    ) : null}
                                  </div>
                                )
                              ) : serviceItemIdProp ? (
                                <PortalDataTableEmpty message="Service not found." icon="service" />
                              ) : (
                              <>
                              <ManagerResidentSectionToolbar
                                title="Services"
                                actions={residentSectionHeaderActions}
                                onAction={onResidentSectionHeaderAction}
                                destinationRow={
                                  <LocalDestinationNav
                                    items={(["pending", "scheduled", "completed"] as const).map((id) => ({
                                      id,
                                      label:
                                        id === "pending"
                                          ? "Pending"
                                          : id === "scheduled"
                                            ? "Scheduled"
                                            : "Completed",
                                      count: residentUnifiedServicesCounts[id],
                                      dataAttr: `resident-services-bucket-${id}`,
                                    }))}
                                    activeId={residentServicesBucket}
                                    onChange={(id) =>
                                      setResidentServicesBucket(id as ResidentUnifiedServicesBucket)
                                    }
                                    ariaLabel="Service status"
                                    appearance="command"
                                    className="w-full"
                                  />
                                }
                                search={{
                                  value: residentServicesSearch,
                                  onChange: setResidentServicesSearch,
                                  placeholder: "Search services",
                                  dataAttr: "resident-services-search",
                                }}
                                overflowMenu={
                                  <PortalIconAction
                                    icon={SettingsIcon}
                                    label={residentsSettingsEntry.label}
                                    data-attr={residentsSettingsEntry.dataAttr}
                                    onClick={() => openResidentDetailSettings("resident")}
                                  />
                                }
                              />
                              {!residentServicesHasRows ? (
                                <p className="text-sm text-muted">No services for this resident.</p>
                              ) : null}
                              {residentServicesHasRows ? (
                                <PortalRecordListSurface isEmpty={false} className="mt-0">
                                  {residentFilteredServiceRequests.map((req) => {
                                    const rowId = `request-${req.id}`;
                                    return (
                                      <PortalServiceRecordRow
                                        key={rowId}
                                        title={req.offerName}
                                        subtitle={managerServiceRequestPricingSummary(req)}
                                        onOpen={() =>
                                          navigate(
                                            managerResidentItemDetailHref(
                                              portalBase,
                                              residentsTab,
                                              selected.id,
                                              "services",
                                              rowId,
                                            ),
                                          )
                                        }
                                        dataAttr="resident-service-row"
                                        menu={residentServiceRowMenu({
                                          label: req.offerName,
                                          onEdit: () =>
                                            navigate(
                                              managerResidentItemDetailHref(
                                                portalBase,
                                                residentsTab,
                                                selected.id,
                                                "services",
                                                rowId,
                                              ),
                                            ),
                                          onDelete: () => void deleteResidentServiceItem({ kind: "request", id: req.id, label: req.offerName }),
                                        })}
                                      />
                                    );
                                  })}
                                  {residentFilteredWorkOrders.map((row) => {
                                    const rowId = `work-order-${row.id}`;
                                    return (
                                      <PortalServiceRecordRow
                                        key={rowId}
                                        title={row.title}
                                        subtitle={[row.status, row.cost?.trim()].filter(Boolean).join(" · ")}
                                        onOpen={() =>
                                          navigate(
                                            managerResidentItemDetailHref(
                                              portalBase,
                                              residentsTab,
                                              selected.id,
                                              "services",
                                              rowId,
                                            ),
                                          )
                                        }
                                        dataAttr="resident-service-row"
                                        menu={residentServiceRowMenu({
                                          label: row.title,
                                          onEdit: () =>
                                            navigate(
                                              managerResidentItemDetailHref(
                                                portalBase,
                                                residentsTab,
                                                selected.id,
                                                "services",
                                                rowId,
                                              ),
                                            ),
                                          onDelete: () => void deleteResidentServiceItem({ kind: "work-order", id: row.id, label: row.title }),
                                        })}
                                      />
                                    );
                                  })}
                                </PortalRecordListSurface>
                              ) : null}
                              {residentServicesAddRow}
                              </>
                              )}
                            </ResidentDetailTabPanel>
                            ) : null}

                            {resolvedDetailTab === "documents" ? (
                              <ResidentDetailTabPanel fill>
                                <ManagerResidentSectionToolbar
                                  title="Documents"
                                  actions={residentSectionHeaderActions}
                                  onAction={onResidentSectionHeaderAction}
                                />
                                <ManagerResidentDocumentsPanel sections={residentDocumentSections} />
                              </ResidentDetailTabPanel>
                            ) : null}

                            </>
                            )}

                          </div>
                          </PortalRecordSectionChrome>
    ) : null;

  const residentsFilterSheet = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([
        propertyFilters,
        portalListGroupModeActiveCount(groupMode, RESIDENT_LIST_DEFAULT_GROUP_MODE),
      ])}
      compactPanel
      commandStripTrigger
      filterFieldCount={propertyOptions.length > 1 ? 2 : 1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => {
        setPropertyFilters([]);
        setGroupMode(RESIDENT_LIST_DEFAULT_GROUP_MODE);
      }}
      dataAttr="residents-filter-sheet-open"
    >
      <PortalListGroupFilterFields
        groupMode={groupMode}
        onGroupModeChange={setGroupMode}
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        propertyDataAttr="residents-filter-property"
        groupModeDataAttr="residents-filter-group-mode"
      />
    </PortalFilterSortSheet>
  );

  return (
    <>
      <LeaseGenerateModal
        open={generateLeaseRow !== null}
        row={generateLeaseRow}
        managerUserId={userId}
        busy={false}
        replacesManagerEdits={Boolean(
          generateLeaseRow?.generatedHtml || generateLeaseRow?.managerUploadedPdf?.dataUrl,
        )}
        onClose={() => setRegenerateConfirmLeaseId(null)}
        onGenerated={() => {
          setLeaseTick((n) => n + 1);
          setRegenerateConfirmLeaseId(null);
        }}
      />
      {signingLease ? (
        <LeaseSigningModal
          row={signingLease}
          signerName=""
          signerRoleLabel="Manager / authorized agent name"
          onSign={handleManagerModalSign}
          onClose={() => {
            setSigningLease(null);
            setSigningLeaseError(null);
          }}
          error={signingLeaseError}
        />
      ) : null}
      {editResidentLeaseId && residentLeaseRows.find((row) => row.id === editResidentLeaseId) ? (
        <ManagerPipelineLeaseEditModal
          open
          row={residentLeaseRows.find((row) => row.id === editResidentLeaseId)!}
          managerUserId={userId}
          onClose={() => setEditResidentLeaseId(null)}
          onDone={() => {
            void syncLeasePipelineFromServer(userId, { force: true }).then(() => setLeaseTick((n) => n + 1));
          }}
          onSendToResident={
            selected &&
            (residentLeaseRows.find((row) => row.id === editResidentLeaseId)?.generatedHtml ||
              residentLeaseRows.find((row) => row.id === editResidentLeaseId)?.managerUploadedPdf?.dataUrl)
              ? () =>
                  openLeaseSendPreview(
                    selected,
                    residentLeaseRows.find((row) => row.id === editResidentLeaseId)!,
                  )
              : undefined
          }
          />
      ) : null}
      {importReviewLease?.uploadedLeaseParse ? (
        <UploadedLeaseReviewModal
          open
          row={importReviewLease}
          parse={importReviewLease.uploadedLeaseParse}
          onClose={() => setImportReviewLeaseId(null)}
          onConfirm={async ({ overrides, note, useConverted, convertedHtml, convertedHtmlSha256, resolvedSourceIssueCodes }) => {
            const result = await confirmUploadedLeaseParseOnServer(importReviewLease.id, {
              managerUserId: userId,
              overrides: overrides as Partial<Record<UploadedLeaseFieldKey, string>>,
              note,
              useConverted,
              convertedHtml,
              convertedHtmlSha256,
              resolvedSourceIssueCodes,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not confirm the imported lease.");
              return;
            }
            track("lease_import_reviewed", { lease_id: importReviewLease.id, import_kind: "uploaded_pdf", artifact_mode: useConverted ? "converted" : "original_pdf" });
            setLeaseTick((n) => n + 1);
            setImportReviewLeaseId(null);
            showToast(`Imported lease confirmed. ${useConverted ? "The converted version" : "The original PDF"} can now be sent for signature.`);
          }}
          onRetryRead={async () => {
            const result = await retryUploadedLeaseParse(importReviewLease.id, userId);
            setLeaseTick((n) => n + 1);
            if (!result.ok) {
              showToast(result.error ?? "Could not read that lease PDF.");
              return;
            }
            showToast(
              result.parse?.status === "parsed"
                ? `Lease imported into PropLane format (${result.parse.sections.length} sections). ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`
                : `PropLane still could not read this PDF. ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`,
            );
          }}
        />
      ) : null}
      {residentIdProp && selected ? (
        <PortalRecordDetailPage
          pageTitle="Residents"
          title={selected.name || "Resident"}
          subtitle={residentRecordSubtitle}
          avatarName={selected.name || undefined}
          backHref={residentDetailItemBackHref}
          backLabel={residentDetailItemBackLabel}
          hideBackText
          bareHeader
          dataAttrBack="resident-detail-back"
          iconTitleActions
          pinScrollBody
          scrollBody={!residentDetailInternalScroll}
          fillBody={residentDetailInternalScroll}
        >
          <PortalRecordActions>
            <PortalRecordHeaderIconActions
              actions={residentRecordHeaderActions}
              onAction={onResidentRecordHeaderAction}
            />
          </PortalRecordActions>
          {residentDetailPanel}
        </PortalRecordDetailPage>
      ) : (
      <ManagerPortalPageShell
        title="Residents"
          hideTitleOnMobileNav
        titleInlineFilter={null}
        compactFilterRow
      >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={RESIDENT_DIRECTORY_TABS.map((tab) => ({
          id: tab,
          label: RESIDENT_DIRECTORY_TAB_LABELS[tab],
          href: residentListHref(portalBase, tab),
          count: directorySourcesReady ? residentTabCounts[tab] : undefined,
          dataAttr: `manager-residents-tab-${tab}`,
        }))}
        activeDestinationId={residentsTab}
        destinationAriaLabel="Resident directory stage"
        search={{ value: residentSearch, onChange: setResidentSearch, placeholder: "Search residents", dataAttr: "residents-search" }}
        actions={residentsFilterSheet}
        primary={
          <PortalPrimaryIconAction
            label="Add resident"
            data-attr="residents-add-top"
            onClick={() => setAddResidentOpen(true)}
          />
        }
        activeFilterChips={
          propertyFilters.length > 0 || groupMode !== RESIDENT_LIST_DEFAULT_GROUP_MODE ? (
            <PortalActiveFilterChips
              chips={[
                ...(groupMode !== RESIDENT_LIST_DEFAULT_GROUP_MODE
                  ? [
                      {
                        id: "group-mode",
                        label: PORTAL_LIST_GROUP_MODE_LABELS[groupMode],
                        onRemove: () => setGroupMode(RESIDENT_LIST_DEFAULT_GROUP_MODE),
                      },
                    ]
                  : []),
                ...(propertyFilters.length > 0
                  ? [
                      {
                        id: "property",
                        label: `Property: ${propertyFilterLabel}`,
                        onRemove: () => setPropertyFilters([]),
                      },
                    ]
                  : []),
              ]}
            />
          ) : null
        }
      />
      <ResidentInviteClaimsPanel
        residentOptions={residents.map((r) => ({
          id: r.axisId || r.id,
          label: `${r.name}${r.propertyLabel ? ` · ${r.propertyLabel}` : ""}`,
        }))}
        propertyLabelFor={(propertyId) =>
          propertyOptions.find((p) => p.id === propertyId)?.label ?? "one of your properties"
        }
        onApproved={() => setPropertyTick((n) => n + 1)}
        showToast={showToast}
      />
      {directoryError && directorySourcesReady ? <div role="alert" className="mb-3 rounded-xl border border-border bg-card p-3 text-sm">Could not refresh residents. Showing the last loaded records. <Button variant="ghost" onClick={() => setDirectoryRetry((n) => n + 1)}>Try again</Button></div> : null}
      <PortalRecordListSurface
        loading={!directorySourcesReady && !directoryError}
        loadError={directoryError && !directorySourcesReady ? "Could not load residents. Your records are still saved." : undefined}
        onRetry={() => setDirectoryRetry((n) => n + 1)}
        isEmpty={filtered.length === 0}
        emptyCard={
          residentSearch.trim()
            ? {
                title: portalEmptyNoMatchTitle("residents", residentSearch),
                section: "residents",
                tone: "muted",
                clear: { label: "Clear search", onClick: () => setResidentSearch(""), dataAttr: "residents-empty-clear-search" },
              }
            : propertyFilters.length > 0
            ? {
                title: portalEmptyNoMatchTitle("residents"),
                section: "residents",
                tone: "muted",
                clear: { label: "Clear filters", onClick: () => setPropertyFilters([]), dataAttr: "residents-empty-clear-filters" },
              }
            : {
                title: portalEmptyCopy(`residents.${residentsTab}` as PortalEmptyCopyKey).title,
                section: "residents",
                sibling: portalEmptySibling(
                  RESIDENT_DIRECTORY_TABS.map((t) => ({
                    id: t,
                    label: RESIDENT_DIRECTORY_TAB_LABELS[t],
                    count: residentTabCounts[t],
                    href: residentListHref(portalBase, t),
                  })),
                  residentsTab,
                ),
                // Past residents are history; a new resident starts as potential or current.
                actions:
                  residentsTab === "past"
                    ? []
                    : [{ label: "Add resident", onClick: () => setAddResidentOpen(true), dataAttr: "residents-empty-add" }],
              }
        }
        onBulkClear={clearSelection}
        bulkCount={listSelectedCount}
        bulkActions={
          // Delete is here, and it is also inside Edit resident. What made it
          // unsafe on a bar was that the bar names nobody, so a row ticked by
          // accident went without ever being read back; the confirmation below
          // lists every resident it is about to destroy.
          <>
            {singleListSelectedApproveRow ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="residents-bulk-approve"
                onClick={() => setApprovePreviewRow(singleListSelectedApproveRow)}
              >
                Approve
              </Button>
            ) : null}
            {singleListSelectedNeedsSetup && singleListSelectedResident ? (
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="residents-bulk-email-setup"
              onClick={() => {
                openResidentEmailSetup(singleListSelectedResident);
              }}
            >
              Send setup
            </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="residents-bulk-completion-reminder"
              disabled={!singleListSelectedReminderRow || applicationReminderPreviewBusyId !== null}
              onClick={() => {
                if (singleListSelectedReminderRow) {
                  void openApplicationCompletionReminderPreview(singleListSelectedReminderRow);
                }
              }}
            >
              Remind to finish
            </Button>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="residents-bulk-edit"
              disabled={!singleListSelectedId}
              onClick={() => {
                if (singleListSelectedId) openEditResidentModal(singleListSelectedId);
              }}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
              data-attr="residents-bulk-delete"
              disabled={listSelectedResidents.length === 0}
              onClick={() => {
                setBulkDeleteOpen(true);
                void loadResidentDeletePreview(listSelectedResidents);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <ManagerResidentsGroupedTable
          clusters={residentListClusters}
          groupMode={groupMode}
          showPropertyInRows={propertyFilters.length > 0 || groupMode === "resident"}
          selectable
          selectedIds={selectedIds}
          onToggleSelected={toggleSelected}
          onToggleCluster={(ids) => togglePortalListClusterSelection(setSelectedIds, ids)}
          nudgeEligibleIds={nudgeEligibleResidentIds}
          onNudge={(res) => {
            const row = readManagerApplicationRows().find((app) => app.id === res.id);
            if (row) void openApplicationCompletionReminderPreview(row);
          }}
          onOpenResident={(res) =>
            navigate(residentDetailHref(portalBase, residentsTab, res.id, resolvedDetailTab))
          }
        />
      </PortalRecordListSurface>

      </ManagerPortalPageShell>
      )}
      <ManagerAddPaymentModal
        open={addResidentPaymentOpen}
        onClose={() => setAddResidentPaymentOpen(false)}
        managerUserId={userId ?? null}
        initialApplicationId={selected?.id}
        initialPropertyId={selected?.propertyId}
        onSubmitted={() => {
          setAddResidentPaymentOpen(false);
          setHcTick((n) => n + 1);
          if (selected?.email) {
            regenerateEditableLeasesForResident(selected.email, userId);
          }
        }}
      />

      <ManagerAddServiceModal
        open={addResidentServiceOpen}
        onClose={() => setAddResidentServiceOpen(false)}
        managerUserId={userId ?? null}
        defaultResident={selectedServiceResident}
        onSubmitted={() => {
          setAddResidentServiceOpen(false);
          setSrTick((n) => n + 1);
          setWorkOrderTick((n) => n + 1);
          setHcTick((n) => n + 1);
          setResidentServicesBucket("pending");
        }}
      />

      <ConfirmDeleteModal
        open={bulkDeleteOpen}
        busy={bulkDeleteBusy}
        title={listSelectedResidents.length === 1 ? "Delete resident" : "Delete residents"}
        confirmLabel={
          listSelectedResidents.length === 1 ? "Delete resident" : `Delete ${listSelectedResidents.length} residents`
        }
        dataAttr="residents-bulk-delete-confirm"
        // Consent is about the counts, so hold Delete until the server has sent
        // them. Cancel stays live — this is not "already deleting".
        confirmDisabled={bulkDeletePreview.loading || bulkDeletePreview.error !== null}
        onClose={() => {
          setBulkDeleteOpen(false);
          setBulkDeletePreview(EMPTY_RESIDENT_DELETE_PREVIEW);
        }}
        onConfirm={() => void deleteSelectedResidents()}
        description={
          <>
            Delete{" "}
            {listSelectedResidents.length === 1
              ? listSelectedResidents[0]?.name || listSelectedResidents[0]?.email || "this resident"
              : `these ${listSelectedResidents.length} residents`}
            , and every application, lease, charge, service and message that belongs to them?
            <span className="mt-2 block space-y-0.5">
              {listSelectedResidents.map((resident) => (
                <span key={resident.id} className="block text-xs text-muted">
                  {/* A row with no name of its own carries the email as its name,
                      so printing both spells the same address twice. */}
                  {resident.name && resident.name !== resident.email ? `${resident.name} · ` : ""}
                  {resident.email || resident.name || resident.id}
                </span>
              ))}
            </span>
            {/* The server's own count of what goes with them. Delete removes all
                of it in one transaction, or none of it. */}
            {bulkDeletePreview.error ? (
              <span className="mt-3 block text-xs text-rose-700">{bulkDeletePreview.error}</span>
            ) : bulkDeletePreview.loading || !bulkDeletePreview.counts ? (
              <span className="mt-3 block text-xs text-muted">Counting what is linked to them…</span>
            ) : (
              <span className="mt-3 block space-y-0.5" data-attr="residents-delete-linked-counts">
                {residentDeletePreviewRows(bulkDeletePreview.counts!).map((row) => (
                  <span key={row.label} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted">{row.label}</span>
                    <span className="font-medium tabular-nums">{row.value}</span>
                  </span>
                ))}
              </span>
            )}
          </>
        }
      />
      <ManagerPortalSettingsModal
        open={residentPaymentSettingsOpen}
        onClose={() => setResidentPaymentSettingsOpen(false)}
        initialTab="payments"
        scopedTitle={settingsDialogTitlePrefix(paymentsSettingsEntry)}
        paymentsMode="incoming"
      />

      {addResidentOpen ? (
        <AddResidentWizard
          onClose={() => setAddResidentOpen(false)}
          managerUserId={userId ?? null}
          propertyOptions={propertyOptions}
          propertyTick={propertyTick}
          executedLeaseKeys={executedLeaseKeys}
          onAdded={() => {
            setChargeBucket("pending");
            setHcTick((n) => n + 1);
            setLeaseTick((n) => n + 1);
          }}
        />
      ) : null}

      {editResidentOpen && editResidentForm ? (
        <AddResidentWizard
          mode="edit"
          initialForm={editResidentForm}
          onClose={() => {
            setEditResidentOpen(false);
            setEditResidentTargetId(null);
            setEditResidentForm(null);
            setEditResidentContext(null);
            setEditResidentRecord(null);
            setEditResidentDocs([]);
          }}
          onAdded={() => {
            setChargeBucket("pending");
            setHcTick((n) => n + 1);
            setLeaseTick((n) => n + 1);
          }}
          editContext={
            editResidentContext
              ? {
                  stage: editResidentContext.stage,
                  baseline: editResidentContext.baseline,
                  signedAtIso: editResidentContext.signedAtIso,
                  onRequestNewTerms: editResidentContext.leaseId
                    ? () => setEditResidentLeaseId(editResidentContext.leaseId!)
                    : undefined,
                  record: editResidentRecord
                    ? { ...editResidentRecord, documents: editResidentDocs }
                    : undefined,
                  onUploadDocument: uploadEditResidentDocument,
                  onDownloadDocument: (id: string) => void downloadEditResidentDocument(id),
                  onRemoveDocument: (id: string) => void removeEditResidentDocument(id),
                }
              : undefined
          }
          onSaveEdit={async (form, opts) => {
            await saveEditedResident(form, opts);
          }}
          managerUserId={userId ?? null}
          propertyOptions={propertyOptions}
          propertyTick={propertyTick}
          executedLeaseKeys={executedLeaseKeys}
        />
      ) : null}

      <Modal
        open={applicationEditOpen && Boolean(selectedApplicationRow?.application)}
        title={
          selectedApplicationRow
            ? `Edit application · ${selectedApplicationRow.name || selected?.name || "Resident"}`
            : "Edit application"
        }
        onClose={() => {
          setApplicationEditOpen(false);
          setApplicationEditInitialStep(undefined);
        }}
        panelClassName="max-w-4xl w-full"
      >
        {selectedApplicationRow?.application ? (
          <ResidentApplicationEditor
            row={selectedApplicationRow}
            residentEmail={(selectedApplicationRow.email ?? selected?.email ?? "").trim().toLowerCase()}
            preserveReviewStatus
            initialStep={applicationEditInitialStep}
            onCancel={() => {
              setApplicationEditOpen(false);
              setApplicationEditInitialStep(undefined);
            }}
            onSaved={async (savedRow) => {
              setApplicationEditOpen(false);
              setApplicationEditInitialStep(undefined);
              const email = (savedRow.email ?? selectedApplicationRow.email ?? selected?.email ?? "")
                .trim()
                .toLowerCase();
              if (email) {
                await syncResidentBillingAndLeases({
                  residentEmail: email,
                  managerUserId: userId ?? null,
                  row: savedRow,
                });
                setLeaseTick((n) => n + 1);
              }
              setHcTick((n) => n + 1);
            }}
          />
        ) : null}
      </Modal>

      <CheckrScreeningModal
        key={checkrScreeningRowId ?? "none"}
        row={
          checkrScreeningRowId
            ? readManagerApplicationRows().find((r) => r.id === checkrScreeningRowId) ?? null
            : null
        }
        open={checkrScreeningRowId !== null}
        showPackagePickerInitially={checkrScreeningShowPicker}
        onClose={() => {
          setCheckrScreeningRowId(null);
          setCheckrScreeningShowPicker(false);
        }}
        onUpdated={handleScreeningUpdated}
      />

      <ApplicationHoldingFeeModal
        row={
          holdingFeeRowId
            ? (() => {
                const row = readManagerApplicationRows().find((r) => r.id === holdingFeeRowId);
                return row ? { ...row, managerUserId: userId ?? null } : null;
              })()
            : null
        }
        open={holdingFeeRowId !== null}
        onClose={() => setHoldingFeeRowId(null)}
      />

      <ApproveApplicationDialog
        row={approvePreviewRow}
        userId={userId ?? null}
        automation={
          approvePreviewRow
            ? applicationAutomation.forProperty(
                approvePreviewRow.assignedPropertyId?.trim() ||
                  approvePreviewRow.propertyId?.trim() ||
                  approvePreviewRow.application?.propertyId?.trim() ||
                  "",
              )
            : undefined
        }
        onClose={() => setApprovePreviewRow(null)}
        onApproved={() => {
          setHcTick((n) => n + 1);
          setLeaseTick((n) => n + 1);
        }}
        onSendLease={(applicationId) => openSendLeaseForApplication(applicationId)}
      />

      <PortalNotificationPreviewModal
        open={welcomePreviewFor !== null}
        title="Send setup"
        onClose={() => setWelcomePreviewFor(null)}
        recipient={welcomePreviewFor?.email ?? ""}
        recipientPhone={
          welcomePreviewFor
            ? (() => {
                const row = readManagerApplicationRows().find((r) => r.id === welcomePreviewFor.id);
                return row?.manualResidentDetails?.phone?.trim() || row?.application?.phone?.trim() || "";
              })()
            : undefined
        }
        subject={RESIDENT_WELCOME_EMAIL_SUBJECT}
        body={welcomePreviewContent}
        emailAvailable={Boolean(welcomePreviewFor?.email?.trim())}
        smsAvailable={Boolean(
          welcomePreviewFor &&
            (() => {
              const row = readManagerApplicationRows().find((r) => r.id === welcomePreviewFor.id);
              return Boolean(row?.manualResidentDetails?.phone?.trim() || row?.application?.phone?.trim());
            })(),
        )}
        defaultViaEmail
        defaultViaSms
        confirmLabel="Send setup"
        confirmLabelWithoutMessage="Close without sending"
        confirmBusy={welcomePreviewFor !== null && welcomeEmailBusyForResident === welcomePreviewFor.id}
        confirmBusyLabel="Sending…"
        onConfirm={(skipMessage, channels, draft) => {
          if (!welcomePreviewFor) return;
          if (skipMessage) {
            setWelcomePreviewFor(null);
            return;
          }
          const res = welcomePreviewFor;
          setWelcomePreviewFor(null);
          void sendResidentAccountEmail(res, { channels, draft });
        }}
      />

      <ShareLeadLinkModal
        open={sendApplicationOpen}
        onClose={() => setSendApplicationOpen(false)}
        kind="apply"
        properties={propertyOptions}
        preselectedPropertyId={selected?.propertyId || undefined}
        initialRecipient={{ name: selected?.name, email: selected?.email, phone: selectedApplicationRow?.manualResidentDetails?.phone ?? selectedApplicationRow?.application?.phone }}
      />

      <UploadForResidentModal
        open={uploadForResidentOpen}
        onClose={() => setUploadForResidentOpen(false)}
        managerUserId={userId ?? null}
        properties={propertyOptions}
        initialKind="application"
        residentApplicationId={selectedApplicationRow?.id ?? null}
        onCreated={() => {
          setLeaseTick((n) => n + 1);
          setHcTick((n) => n + 1);
        }}
      />

      <LeaseSendSheet
        open={sendLeaseTarget !== null}
        leaseId={sendLeaseTarget?.leaseId}
        applicationId={sendLeaseTarget?.applicationId}
        managerUserId={userId ?? null}
        onClose={() => setSendLeaseTarget(null)}
        onSent={() => {
          setLeaseTick((n) => n + 1);
          setHcTick((n) => n + 1);
        }}
      />

      <PortalNotificationPreviewModal
        open={leaseReminderPreview !== null}
        title="Lease signing reminder · preview"
        onClose={() => setLeaseReminderPreview(null)}
        recipient={leaseReminderPreview?.recipient ?? ""}
        subject={leaseReminderPreview?.subject ?? ""}
        body={leaseReminderPreview?.body ?? ""}
        showSkipMessage={false}
        confirmLabel="Send reminder"
        confirmLabelWithoutMessage="Close without sending"
        confirmBusy={leaseReminderBusy}
        confirmBusyLabel="Sending…"
        onConfirm={(skipMessage, channels, draft) => {
          if (!leaseReminderPreview) return;
          if (skipMessage) {
            setLeaseReminderPreview(null);
            return;
          }
          const preview = leaseReminderPreview;
          setLeaseReminderPreview(null);
          void sendLeaseSigningReminder(
            preview.res,
            preview.leaseId,
            draft?.subject ?? preview.subject,
            draft?.body ?? preview.body,
            channels,
          );
        }}
      />

      <PortalNotificationPreviewModal
        open={applicationReminderPreview !== null}
        title="Send application reminder"
        onClose={() => setApplicationReminderPreview(null)}
        recipient={applicationReminderPreview?.to ?? ""}
        subject={applicationReminderPreview?.subject ?? APPLICATION_COMPLETION_REMINDER_SUBJECT}
        body={applicationReminderPreview?.text ?? ""}
        showSkipMessage={false}
        showChannelPicker
        emailAvailable
        smsAvailable
        deliverViaKind="applications"
        dynamicSendLabel
        assistantContext="Application completion reminder"
        confirmLabel="Send reminder"
        confirmBusy={applicationReminderBusyId !== null}
        confirmBusyLabel="Sending…"
        onConfirm={(_skip, channels, draft) => {
          if (!applicationReminderPreview) return;
          void sendApplicationCompletionReminder(applicationReminderPreview.row, channels, draft);
        }}
      />

      {/*
        Shared by every resident-detail Settings gear that routes through
        `openResidentDetailSettings` (lease, applications, resident, and the
        embedded tours subsection) — one dialog instance, so its title is
        resolved per-tab from the same registry the triggering button's own
        label (where we control it) comes from, instead of a fixed string.
      */}
      <ProPortalSettingsModal
        open={residentDetailSettingsOpen}
        onClose={() => setResidentDetailSettingsOpen(false)}
        initialTab={residentDetailSettingsTab}
        scoped
        scopedTitle={settingsDialogTitlePrefix(getSettingsEntryPointForTab(residentDetailSettingsTab))}
        propertyOptions={propertyOptions}
        initialPropertyId={selected?.propertyId?.trim() || propertyOptions[0]?.id}
      />

      <ManagerResidentUploadModal
        open={residentUploadOpen}
        residentName={selected?.name || "Resident"}
        defaultKind={residentUploadKindPreset}
        onClose={() => setResidentUploadOpen(false)}
        onUploaded={handleResidentUploadComplete}
      />

      <PortalNotificationPreviewModal
        open={messageOpen}
        title={
          messageScheduleLater
            ? "Schedule message"
            : selected?.name
              ? `Message ${selected.name}`
              : "New message"
        }
        onClose={() => {
          if (messageBusy) return;
          setMessageOpen(false);
          setMessageScheduleLater(false);
          setMessageReminderForPayment(false);
        }}
        initialScheduleLater={messageScheduleLater}
        scheduledRecipientEmail={selected?.email}
        scheduledSmsAvailable={Boolean(
          selected &&
            (() => {
              const row = readManagerApplicationRows().find((r) => r.id === selected.id);
              return Boolean(row?.manualResidentDetails?.phone?.trim() || row?.application?.phone?.trim());
            })(),
        )}
        scheduledRefreshKey={messageScheduledRefresh}
        onScheduledMessagesChanged={() => setMessageScheduledRefresh((n) => n + 1)}
        recipient={selected?.email ?? ""}
        recipientPhone={
          selected
            ? (() => {
                const row = readManagerApplicationRows().find((r) => r.id === selected.id);
                return row?.manualResidentDetails?.phone?.trim() || row?.application?.phone?.trim() || "";
              })()
            : undefined
        }
        subject=""
        body=""
        showSkipMessage={false}
        smsAvailable={Boolean(
          selected &&
            (() => {
              const row = readManagerApplicationRows().find((r) => r.id === selected.id);
              return Boolean(row?.manualResidentDetails?.phone?.trim() || row?.application?.phone?.trim());
            })(),
        )}
        defaultViaSms={false}
        confirmLabel={messageScheduleLater ? "Schedule message" : "Send message"}
        confirmBusy={messageBusy}
        confirmBusyLabel={messageScheduleLater ? "Scheduling…" : "Sending…"}
        onConfirm={(_skip, channels, draft) => {
          void sendResidentMessage(channels, draft);
        }}
      />

    </>
  );
}
