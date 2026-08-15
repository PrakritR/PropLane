"use client";

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { cn } from "@/lib/utils";
import { useCommunicationSurfaceChrome } from "@/hooks/use-communication-surface-chrome";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SegmentedThree } from "@/components/ui/segmented-control";
import { PortalDetailDestinationNav } from "@/components/portal/portal-detail-destination-nav";
import { PortalPageChrome, PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import {Input, Textarea, Select, NativeSelect} from "@/components/ui/input";
import {
  Modal,
  ModalFooter,
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_FULL_ROW_CLASS,
  PORTAL_MODAL_FORM_GRID_CLASS,
} from "@/components/ui/modal";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  MANAGER_TABLE_TH,
  ManagerPortalPageShell,
  PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE,
  RESIDENT_DETAIL_HEADER_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import {
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PortalDataTableEmpty,
  PORTAL_DETAIL_BTN,
  ResidentDocumentsDetailFooter,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_EXPAND_TH,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_HEAD_ROW,
  PortalTableExpandCell,
  createPortalRowExpandClick,
} from "@/components/portal/portal-data-table";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/manager-payments-ledger-panel";
import {
  ReminderSettingsModal,
  useScheduledPaymentMessages,
} from "@/components/portal/payment-schedule-ui";
import { formatFriendlyReminderSchedule } from "@/lib/payment-reminder-presets";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import type { ManagerPaymentBucket } from "@/data/demo-portal";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPageFooterActions, PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import {
  RESIDENT_DETAIL_TAB_LABELS,
  RESIDENT_DETAIL_TAB_SHORT_LABELS,
  residentDetailHref,
  residentPaymentDetailHref,
  parseResidentDetailTab,
  type ResidentDetailTabId,
} from "@/lib/portal-detail-routes";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalListAddRow, PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";
import { LeasePrimaryHeaderActions } from "@/components/portal/lease-primary-header-actions";
import { LeaseGenerateModal } from "@/components/portal/lease-generate-modal";
import { LeaseSigningModal } from "@/components/portal/lease-signing-modal";
import { ManagerPipelineLeaseEditModal } from "@/components/portal/manager-pipeline-lease-edit-modal";
import { PropertyResidentPdfUploadCard } from "@/components/portal/property-resident-onboard-wizard";
import { mergeParsedFields } from "@/lib/resident-document-import/onboard-draft";
import { mapParsedFieldsToAddResidentForm } from "@/lib/resident-document-import/apply-parsed-to-add-resident";
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
  readChargesForManagerResident,
  recordApprovedApplicationCharges,
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
  collectLinkedPropertyIds,
  collectLinkedPropertyIdsForModule,
  MANAGER_PORTFOLIO_REFRESH_EVENTS,
} from "@/lib/manager-portfolio-access";
import { isPreviousResidentDirectoryRow, isResidentDirectoryRow } from "@/lib/current-resident";
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

import {
  buildMockPropertyFromDraft,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  appendLeaseThreadMessage,
  deleteLeasePipelineRow,
  deleteLeasePipelineRowsForResident,
  regenerateEditableLeasesForResident,
  leaseGenerationSupportedForRow,
  managerSignLease,
  leaseAllowsManagerDocumentEdits,
  leaseAllowsManagerGeneratedBodyEdits,
  leasePipelineRowsForManagerResident,
  LEASE_PIPELINE_EVENT,
  confirmUploadedLeaseParse,
  leaseNeedsUploadedLeaseReviewAction,
  leaseSendGateBlocker,
  UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE,
  readLeasePipeline,
  residentCanViewLeaseRow,
  sendLeaseBackToManager,
  sendLeaseToResident,
  syncLeasePipelineFromApplications,
  syncLeasePipelineFromServer,
  runLeaseDownload,
  hasBothLeaseSignatures,
  residentHasSignedLease,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { retryUploadedLeaseParse, uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
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
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import type { DemoApplicantRow, ManagerApplicationBucket, ManagerWorkOrderBucket } from "@/data/demo-portal";
import { transitionApplicationBucket } from "@/lib/application-review";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import {
  APPLICATION_COMPLETION_REMINDER_SUBJECT,
  buildApplicationCompletionReminderBody,
} from "@/lib/application-completion-reminder-email";
import {
  inProgressApplicationResumeUrl,
  isInProgressApplicationRow,
  shouldOfferApplicationCompletionReminder,
} from "@/lib/rental-application/in-progress-application";
import { buildApplicationGroups, groupForRow } from "@/lib/rental-application/application-groups";
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
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { groupIdForRow, groupRowInputForRow } from "@/components/portal/application-group-section";
import {
  ApplicationCosignerSection,
  ApplicationHouseholdCluster,
} from "@/components/portal/application-household-list";
import { groupHouseLabel, numberGroupsByHouse } from "@/lib/rental-application/group-house-label";
import { ApplicationHoldingFeeModal } from "@/components/portal/application-holding-fee-box";
import { useCosignerSubmissionsMap } from "@/hooks/use-cosigner-submissions-map";
import { signerAppIdsForCosignerLookup } from "@/lib/rental-application/application-list-grouping";
import {
  ApplicationReviewLauncherRow,
  type ApplicationReviewView,
} from "@/components/portal/application-review-launcher-row";
import { downloadBackgroundCheckForApplication } from "@/components/portal/application-screening-panel";
import { runApplicationPdfDownload } from "@/components/portal/manager-applications";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { ResidentApplicationEditor } from "@/components/portal/resident-application-editor";
import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";
import { ManagerResidentDetailInbox } from "@/components/portal/manager-resident-detail-inbox";
import {
  ServiceStatusBadge,
} from "@/components/portal/resident-services-panel";
import {
  ManagerServiceRequestDetail,
  managerServiceRequestBucket,
  managerServiceRequestPricingSummary,
  type ManagerServiceRequestBucket,
} from "@/components/portal/manager-service-request-detail";
import { ManagerWorkOrdersPanel } from "@/components/portal/manager-work-orders-panel";

import { ManagerAddPaymentModal } from "@/components/portal/manager-add-payment-modal";
import { ManagerPaymentSetupModal } from "@/components/portal/manager-payment-setup-modal";
import {
  ManagerCreateServiceRequestModal,
  type ManagerServiceResidentOption,
} from "@/components/portal/manager-create-service-request-modal";
import { ManagerCreateWorkOrderModal } from "@/components/portal/manager-create-work-order-modal";
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
  manualResidentDetails?: NonNullable<import("@/data/demo-portal").DemoApplicantRow["manualResidentDetails"]>;
  isPrevious: boolean;
};

type ResidentsTabId = "current";

const RESIDENTS_LIST_TAB: ResidentsTabId = "current";

function shortDateLabel(iso: string): string {
  const parts = iso.trim().split("-").map(Number);
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return iso;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

export function ManagerResidents({
  tabId: _tabId = "current",
  residentId: residentIdProp,
  detailTab: detailTabProp,
  paymentId: paymentIdProp,
  smsUiEnabled = false,
}: {
  tabId?: ResidentsTabId;
  residentId?: string;
  detailTab?: ResidentDetailTabId;
  paymentId?: string;
  smsUiEnabled?: boolean;
}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const portalBase = usePaidPortalBasePath();
  const { userId, email: managerEmail, ready: authReady } = useManagerUserId();
  const {
    messages: scheduledPaymentMessages,
    settings: residentReminderSettings,
    reload: reloadResidentPaymentSchedule,
    setSettings: setResidentReminderSettings,
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
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const residentsTab = RESIDENTS_LIST_TAB;
  const [chargeBucket, setChargeBucket] = useState<ManagerPaymentBucket>("pending");
  const [residentReminderSettingsOpen, setResidentReminderSettingsOpen] = useState(false);
  const [prevSelectedId, setPrevSelectedId] = useState<string | null>(null);
  const [residentAccountEmails, setResidentAccountEmails] = useState<Set<string>>(new Set());
  const [uploadingLeaseRowId, setUploadingLeaseRowId] = useState<string | null>(null);
  const [importReviewLeaseId, setImportReviewLeaseId] = useState<string | null>(null);
  const [editResidentLeaseId, setEditResidentLeaseId] = useState<string | null>(null);
  const [activeResidentLeaseId, setActiveResidentLeaseId] = useState<string | null>(null);
  const [regenerateConfirmLeaseId, setRegenerateConfirmLeaseId] = useState<string | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);
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
  const [leaseSentPreview, setLeaseSentPreview] = useState<{
    res: ActiveResident;
    lease: LeasePipelineRow;
    recipient: string;
    subject: string;
    body: string;
  } | null>(null);
  const [leaseSendBusy, setLeaseSendBusy] = useState(false);
  const [signingLease, setSigningLease] = useState<LeasePipelineRow | null>(null);
  const [welcomeEmailBusyForResident, setWelcomeEmailBusyForResident] = useState<string | null>(null);
  const [welcomePreviewFor, setWelcomePreviewFor] = useState<ActiveResident | null>(null);
  const [welcomePreviewContent, setWelcomePreviewContent] = useState("");
  const [approvePreviewRow, setApprovePreviewRow] = useState<DemoApplicantRow | null>(null);
  const [checkrScreeningRowId, setCheckrScreeningRowId] = useState<string | null>(null);
  const [holdingFeeRowId, setHoldingFeeRowId] = useState<string | null>(null);
  const [checkrScreeningShowPicker, setCheckrScreeningShowPicker] = useState(false);
  const [applicationReviewView, setApplicationReviewView] = useState<ApplicationReviewView>("application");
  const [approveBusyId, setApproveBusyId] = useState<string | null>(null);
  const [applicationReminderPreview, setApplicationReminderPreview] = useState<{
    row: DemoApplicantRow;
    to: string;
    subject: string;
    text: string;
  } | null>(null);
  const [applicationReminderPreviewBusyId, setApplicationReminderPreviewBusyId] = useState<string | null>(null);
  const [applicationReminderBusyId, setApplicationReminderBusyId] = useState<string | null>(null);

  // Services tab replica (Requests / Work orders — mirrors resident-services-panel.tsx)
  const [svcSubTab, setSvcSubTab] = useState<"requests" | "work-orders">("requests");
  const [svcReqBucket, setSvcReqBucket] = useState<ManagerServiceRequestBucket>("pending");
  const [svcWoBucket, setSvcWoBucket] = useState<ManagerWorkOrderBucket>("open");
  const [svcExpandedId, setSvcExpandedId] = useState<string | null>(null);

  const activeDetailTab = parseResidentDetailTab(detailTabProp);
  const [applicationEditOpen, setApplicationEditOpen] = useState(false);
  const [residentPaymentSetupOpen, setResidentPaymentSetupOpen] = useState(false);
  const [addResidentPaymentOpen, setAddResidentPaymentOpen] = useState(false);
  const [addResidentRequestOpen, setAddResidentRequestOpen] = useState(false);
  const [addResidentWorkOrderOpen, setAddResidentWorkOrderOpen] = useState(false);
  const [embeddedPaymentFooterActions, setEmbeddedPaymentFooterActions] = useState<ReactNode>(null);
  const [embeddedPaymentBulkActions, setEmbeddedPaymentBulkActions] = useState<ReactNode>(null);
  const handleEmbeddedPaymentFooterActions = useCallback((actions: ReactNode | null) => {
    setEmbeddedPaymentFooterActions(actions);
  }, []);
  const handleEmbeddedPaymentBulkActions = useCallback((actions: ReactNode | null) => {
    setEmbeddedPaymentBulkActions(actions);
  }, []);
  // Add resident manually
  const [addResidentOpen, setAddResidentOpen] = useState(false);
  const [arName, setArName] = useState("");
  const [arEmail, setArEmail] = useState("");
  const [arPhone, setArPhone] = useState("");
  const [arPropertyId, setArPropertyId] = useState("");
  const [arRoomId, setArRoomId] = useState("");
  const [arBundleId, setArBundleId] = useState("");
  const [arLeaseTerm, setArLeaseTerm] = useState("");
  const [arLeaseTermCustomMode, setArLeaseTermCustomMode] = useState(false);
  const [arMoveInDate, setArMoveInDate] = useState("");
  const [arMoveOutDate, setArMoveOutDate] = useState("");
  const [arRent, setArRent] = useState("");
  const [arUtilities, setArUtilities] = useState("");
  const [arMoveInFee, setArMoveInFee] = useState("");
  const [arSecurityDeposit, setArSecurityDeposit] = useState("");
  const [arNotes, setArNotes] = useState("");
  const [arSignedLeaseFileName, setArSignedLeaseFileName] = useState("");
  const [arSignedLeaseDataUrl, setArSignedLeaseDataUrl] = useState("");
  const [addResidentNoticePreview, setAddResidentNoticePreview] = useState<DemoApplicantRow | null>(null);
  const [arSaving, setArSaving] = useState(false);
  const [arPdfBusy, setArPdfBusy] = useState(false);
  const [arApplicationFile, setArApplicationFile] = useState<File | null>(null);
  const [arLeaseImportFile, setArLeaseImportFile] = useState<File | null>(null);
  const [arApplicationParse, setArApplicationParse] = useState<ParsedResidentDocument | null>(null);
  const [arLeaseParse, setArLeaseParse] = useState<ParsedResidentDocument | null>(null);
  const arApplicationUploadRef = useRef<HTMLInputElement>(null);
  const arLeaseImportUploadRef = useRef<HTMLInputElement>(null);

  // Edit resident
  const erSkipPricingFillRef = useRef(false);
  const [editResidentOpen, setEditResidentOpen] = useState(false);
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
    void Promise.allSettled([
      syncPropertyPipelineFromServer(),
      syncManagerApplicationsFromServer({ managerUserId: userId }),
      syncLeasePipelineFromServer(userId),
      syncManagerWorkOrdersFromServer(),
      syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY),
      syncHouseholdChargesFromServer(),
    ]).then(() => {
      if (!cancelled) {
        setPropertyTick((n) => n + 1);
        setInboxTick((n) => n + 1);
        setWorkOrderTick((n) => n + 1);
        setHcTick((n) => n + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId]);

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
  }, [userId, hcTick, propertyTick]);

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

  const residents = useMemo<ActiveResident[]>(() => {
    void hcTick;
    // `propertyTick` is a cache-invalidation signal, not a value read here:
    // `applicationVisibleToPortalUser` consults the module-level property
    // pipeline cache, which React cannot see. Re-filter once that cache
    // hydrates so linked-property rows appear without a manual refresh.
    void propertyTick;
    return readManagerApplicationRows()
      .filter((row) => isResidentDirectoryRow(row) && applicationVisibleToPortalUser(row, userId, "residents"))
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
        return {
          id: row.id,
          name: row.name,
          email: (row.email ?? "").trim(),
          propertyId: propId,
          propertyLabel,
          roomLabel,
          groupId: groupIdForRow(row).trim().toUpperCase(),
          signedMonthlyRent: row.signedMonthlyRent ?? null,
          leaseStart,
          leaseEnd,
          axisId: normalizeApplicationAxisId(row.id),
          manuallyAdded: row.manuallyAdded,
          moveInInstructions: row.moveInInstructions,
          manualResidentDetails: row.manualResidentDetails,
          isPrevious: isPreviousResidentDirectoryRow(row),
        };
      });
  }, [userId, hcTick, propertyTick]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    const labelById = new Map<string, string>();
    if (userId) {
      for (const p of readExtraListingsForUser(userId)) {
        labelById.set(p.id, (p.buildingName || p.title?.replace(/\s*·\s*\d+\s*rooms?\s*$/i, "") || p.address || p.id).trim());
      }
      for (const p of readPendingManagerPropertiesForUser(userId)) {
        const built = buildMockPropertyFromDraft(p, p.id);
        const label = [built.buildingName, built.address].filter(Boolean).join(" · ").trim() || built.title;
        labelById.set(p.id, label);
      }
    }
    for (const r of residents) {
      if (r.propertyId && !labelById.has(r.propertyId)) {
        labelById.set(r.propertyId, r.propertyLabel || r.propertyId);
      }
    }
    return [...labelById.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [residents, userId, propertyTick]);

  const arPdfPropertyId = arPropertyId || propertyOptions[0]?.id || "";

  function acceptAddResidentPdfFile(file: File | undefined, input: HTMLInputElement | null): file is File {
    if (!file) return false;
    if (file.type !== "application/pdf") {
      showToast("Please choose a PDF file.");
      if (input) input.value = "";
      return false;
    }
    if (file.size > 3.5 * 1024 * 1024) {
      showToast("PDF too large (max 3.5 MB).");
      if (input) input.value = "";
      return false;
    }
    return true;
  }

  function applyParsedToAddResidentForm(
    applicationParse: ParsedResidentDocument | null,
    leaseParse: ParsedResidentDocument | null,
  ) {
    const merged = mergeParsedFields(applicationParse, leaseParse);
    const primaryParse = leaseParse ?? applicationParse;
    const propertyIdForPresets =
      primaryParse?.propertyMatch?.propertyId?.trim() || arPropertyId || arPdfPropertyId;
    const leaseTermPresetValues = propertyIdForPresets
      ? residentLeaseTermOptionsForProperty(propertyIdForPresets).map((opt) => opt.value)
      : [];
    const mapped = mapParsedFieldsToAddResidentForm({
      fields: merged,
      parse: primaryParse,
      leaseTermPresetValues,
    });
    if (mapped.name) setArName(mapped.name);
    if (mapped.email) setArEmail(mapped.email);
    if (mapped.phone) setArPhone(mapped.phone);
    if (mapped.propertyId) setArPropertyId(mapped.propertyId);
    if (mapped.roomId && mapped.propertyId && isPropertyRentedByRoom(mapped.propertyId)) {
      setArRoomId(mapped.roomId);
    }
    if (mapped.leaseTerm) {
      setArLeaseTerm(mapped.leaseTerm);
      setArLeaseTermCustomMode(Boolean(mapped.leaseTermCustomMode));
    }
    if (mapped.moveInDate) setArMoveInDate(mapped.moveInDate);
    if (mapped.moveOutDate) setArMoveOutDate(mapped.moveOutDate);
    if (mapped.rent) setArRent(mapped.rent);
    if (mapped.utilities) setArUtilities(mapped.utilities);
    if (mapped.moveInFee) setArMoveInFee(mapped.moveInFee);
    if (mapped.securityDeposit) setArSecurityDeposit(mapped.securityDeposit);
  }

  async function handleAddResidentApplicationPdf(file: File) {
    const propertyId = arPdfPropertyId;
    if (!propertyId) {
      showToast("Add a property listing before uploading an application PDF.");
      return;
    }
    setArPdfBusy(true);
    try {
      const url = await readDataUrlFromFile(file);
      const parsed = await parseResidentDocumentPdfClient({
        dataUrl: url,
        fileName: file.name,
        kind: "application",
        propertyId,
      });
      setArApplicationFile(file);
      setArApplicationParse(parsed);
      applyParsedToAddResidentForm(parsed, arLeaseParse);
      if (parsed.warnings[0]) showToast(parsed.warnings[0]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not read application PDF.");
    } finally {
      setArPdfBusy(false);
      if (arApplicationUploadRef.current) arApplicationUploadRef.current.value = "";
    }
  }

  async function handleAddResidentLeasePdf(file: File) {
    const propertyId = arPdfPropertyId;
    if (!propertyId) {
      showToast("Add a property listing before uploading a lease PDF.");
      return;
    }
    setArPdfBusy(true);
    try {
      const url = await readDataUrlFromFile(file);
      const parsed = await parseResidentDocumentPdfClient({
        dataUrl: url,
        fileName: file.name,
        kind: "lease",
        propertyId,
      });
      setArLeaseImportFile(file);
      setArLeaseParse(parsed);
      setArSignedLeaseDataUrl(url);
      setArSignedLeaseFileName(file.name);
      applyParsedToAddResidentForm(arApplicationParse, parsed);
      if (parsed.warnings[0]) showToast(parsed.warnings[0]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not read lease PDF.");
    } finally {
      setArPdfBusy(false);
      if (arLeaseImportUploadRef.current) arLeaseImportUploadRef.current.value = "";
    }
  }

  const arRoomOptions = useMemo(() => {
    void propertyTick;
    if (!arPropertyId || !userId) return [];
    const listing = readExtraListingsForUser(userId).find((p) => p.id === arPropertyId);
    if (!listing?.listingSubmission) return [];
    const sub = normalizeManagerListingSubmissionV1(listing.listingSubmission);
    return sub.rooms.map((r) => ({
      id: r.id,
      name: r.name || r.id,
      monthlyRent: r.monthlyRent,
      shortTermRent: r.shortTermRent,
    }));
  }, [arPropertyId, userId, propertyTick]);

  const erRoomOptions = useMemo(() => {
    void propertyTick;
    if (!erPropertyId || !userId) return [];
    const listing = readExtraListingsForUser(userId).find((p) => p.id === erPropertyId);
    if (!listing?.listingSubmission) return [];
    const sub = normalizeManagerListingSubmissionV1(listing.listingSubmission);
    return sub.rooms.map((r) => ({
      id: r.id,
      name: r.name || r.id,
      monthlyRent: r.monthlyRent,
      shortTermRent: r.shortTermRent,
    }));
  }, [erPropertyId, userId, propertyTick]);

  const arLeaseTermOptions = useMemo(
    () => residentLeaseTermOptionsForProperty(arPropertyId),
    [arPropertyId, propertyTick],
  );
  const arLeaseTermPresetValues = useMemo(
    () => arLeaseTermOptions.map((o) => o.value),
    [arLeaseTermOptions],
  );
  const erLeaseTermOptions = useMemo(
    () => residentLeaseTermOptionsForProperty(erPropertyId),
    [erPropertyId, propertyTick],
  );
  const erLeaseTermPresetValues = useMemo(
    () => erLeaseTermOptions.map((o) => o.value),
    [erLeaseTermOptions],
  );

  const arLeaseTermSelectValue = useMemo(
    () => residentLeaseTermSelectValue(arLeaseTerm, arLeaseTermCustomMode, arLeaseTermPresetValues),
    [arLeaseTerm, arLeaseTermCustomMode, arLeaseTermPresetValues],
  );

  const isMonthToMonthLease = isResidentMonthToMonthLease(arLeaseTerm, arPropertyId);

  const arManualLeaseFields = useMemo(
    () => residentLeaseTermToApplicationFields(arLeaseTerm, arLeaseTermCustomMode, arPropertyId),
    [arLeaseTerm, arLeaseTermCustomMode, arPropertyId],
  );
  const arIsShortTermStay = arManualLeaseFields.rentalType === "short_term";

  const erManualLeaseFields = useMemo(
    () => residentLeaseTermToApplicationFields(erLeaseTerm, erLeaseTermCustomMode, erPropertyId),
    [erLeaseTerm, erLeaseTermCustomMode, erPropertyId],
  );
  const erIsShortTermStay = erManualLeaseFields.rentalType === "short_term";

  const arRentedByRoom = useMemo(
    () => Boolean(arPropertyId.trim() && isPropertyRentedByRoom(arPropertyId)),
    [arPropertyId, propertyTick],
  );
  const arEntireHome = useMemo(
    () => Boolean(arPropertyId.trim() && isEntireHomeProperty(arPropertyId)),
    [arPropertyId, propertyTick],
  );
  const arBundleOptions = useMemo(
    () =>
      arPropertyId.trim()
        ? getBundleOptionsForProperty(arPropertyId, { rentalType: arIsShortTermStay ? "short_term" : "standard" })
        : [],
    [arPropertyId, arIsShortTermStay, propertyTick],
  );
  const arShowBundleSelect = arBundleOptions.length > 0;
  const arShowRoomSelect = arRentedByRoom && !arBundleId.trim() && arRoomOptions.length > 0;
  const arShowRoomSetupNote = arRentedByRoom && !arBundleId.trim() && arRoomOptions.length === 0;
  const arShowWholeUnitPlacementNote =
    Boolean(arPropertyId.trim()) && !arRentedByRoom && !arShowBundleSelect;

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

  const arStayPreview = useMemo(() => {
    if (!arIsShortTermStay) return null;
    const nights = shortTermStayNightCount(arMoveInDate, arMoveOutDate);
    const nightly = shortTermNightlyRate(arRent);
    if (!nights || !nightly) return null;
    return shortTermStayChargeTitle(nights, nightly);
  }, [arIsShortTermStay, arMoveInDate, arMoveOutDate, arRent]);

  const erStayPreview = useMemo(() => {
    if (!erIsShortTermStay) return null;
    const nights = shortTermStayNightCount(erMoveInDate, erMoveOutDate);
    const nightly = shortTermNightlyRate(erRent);
    if (!nights || !nightly) return null;
    return shortTermStayChargeTitle(nights, nightly);
  }, [erIsShortTermStay, erMoveInDate, erMoveOutDate, erRent]);

  useEffect(() => {
    if (arIsShortTermStay) setArUtilities("0");
  }, [arIsShortTermStay]);

  useEffect(() => {
    if (!arBundleId.trim()) return;
    if (arBundleOptions.some((o) => o.value === arBundleId)) return;
    setArBundleId("");
  }, [arBundleId, arBundleOptions]);

  useEffect(() => {
    if (erIsShortTermStay) setErUtilities("0");
  }, [erIsShortTermStay]);

  useEffect(() => {
    if (!erBundleId.trim()) return;
    if (erBundleOptions.some((o) => o.value === erBundleId)) return;
    setErBundleId("");
  }, [erBundleId, erBundleOptions]);

  useEffect(() => {
    if (!addResidentOpen) return;
    if (!arPropertyId.trim() || !arLeaseTerm.trim()) return;
    const pricing = resolveManualResidentPlacementValues({
      propertyId: arPropertyId,
      roomId: arRoomId,
      bundleId: arBundleId,
      leaseTerm: arLeaseTerm,
      leaseTermCustomMode: arLeaseTermCustomMode,
    });
    if (!pricing) return;
    setArRent(pricing.rent);
    setArUtilities(pricing.utilities);
    setArMoveInFee(pricing.moveInFee);
    setArSecurityDeposit(pricing.securityDeposit);
  }, [addResidentOpen, arPropertyId, arRoomId, arBundleId, arLeaseTerm, arLeaseTermCustomMode, propertyTick]);

  useEffect(() => {
    if (!addResidentOpen) return;
    if (arManualLeaseFields.rentalType === "short_term") return;
    const term = arManualLeaseFields.leaseTerm;
    if (!arMoveInDate.trim() || !shouldAutoComputeLeaseEnd(term, arManualLeaseFields.rentalType)) return;
    const end = computeLeaseEndDate(arMoveInDate, term);
    if (end) setArMoveOutDate(end);
  }, [addResidentOpen, arMoveInDate, arLeaseTerm, arLeaseTermCustomMode, arManualLeaseFields.leaseTerm, arManualLeaseFields.rentalType]);

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

  if (isMonthToMonthLease && arMoveOutDate) {
    setArMoveOutDate("");
  }

  if (isEditMonthToMonthLease && erMoveOutDate) {
    setErMoveOutDate("");
  }

  const filtered = useMemo(() => {
    const inTab = residents.filter((resident) => !resident.isPrevious);
    const base = propertyFilters.length > 0
      ? inTab.filter((r) => propertyFilters.includes(r.propertyId))
      : inTab;
    const q = searchQuery.trim().toLowerCase();
    const searched = q
      ? base.filter((r) =>
          [r.name, r.email, r.roomLabel, r.propertyLabel, r.axisId]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : base;

    return [...searched].sort((a, b) => {
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
  }, [residents, propertyFilters, searchQuery]);

  /**
   * "Group 1" per HOUSE, numbered over EVERY resident rather than the filtered
   * list — a search or property filter must not renumber a household, and the
   * number has to agree with the one Applications and Leases print.
   */
  const residentGroupNumbers = useMemo(
    () =>
      numberGroupsByHouse(
        residents.map((res) => ({ groupId: res.groupId, property: res.propertyLabel })),
      ),
    [residents],
  );

  /**
   * The visible list, with housemates collected under one header. Grouped rows are
   * pulled together at the position of the group's FIRST row, so the surrounding
   * sort order is otherwise preserved; ungrouped residents stay individual rows.
   */
  const residentListClusters = useMemo(() => {
    type Cluster = { groupId: string; property: string | null; ordinal: number; rows: ActiveResident[] };
    const out: Cluster[] = [];
    const byGroup = new Map<string, Cluster>();
    for (const res of filtered) {
      // A group of one is not a household — render it as a plain row.
      const grouped =
        res.groupId && filtered.filter((other) => other.groupId === res.groupId).length > 1;
      if (!grouped) {
        out.push({ groupId: "", property: null, ordinal: 0, rows: [res] });
        continue;
      }
      const existing = byGroup.get(res.groupId);
      if (existing) {
        existing.rows.push(res);
        continue;
      }
      const numbering = residentGroupNumbers.get(res.groupId);
      const cluster: Cluster = {
        groupId: res.groupId,
        property: numbering?.property ?? null,
        ordinal: numbering?.ordinal ?? 1,
        rows: [res],
      };
      byGroup.set(res.groupId, cluster);
      out.push(cluster);
    }
    return out;
  }, [filtered, residentGroupNumbers]);

  const activeResidentId = residentIdProp ? decodeURIComponent(residentIdProp) : null;
  const selected = useMemo(
    () => (activeResidentId ? residents.find((r) => r.id === activeResidentId) ?? null : null),
    [residents, activeResidentId],
  );

  if (activeResidentId !== prevSelectedId) {
    setPrevSelectedId(activeResidentId);
    if (activeResidentId) {
      setChargeBucket("pending");
      setSvcSubTab("requests");
      setSvcReqBucket("pending");
      setSvcWoBucket("open");
      setSvcExpandedId(null);
      setApplicationReviewView("application");
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

  useEffect(() => {
    if (!selected?.id) {
      setActiveResidentLeaseId(null);
      return;
    }
    setActiveResidentLeaseId((current) => {
      if (current && residentLeaseRows.some((row) => row.id === current)) return current;
      return residentLeaseRows[0]?.id ?? null;
    });
  }, [residentLeaseRows, selected?.id]);

  const residentLease = useMemo<LeasePipelineRow | null>(() => {
    if (residentLeaseRows.length === 0) return null;
    if (activeResidentLeaseId) {
      return residentLeaseRows.find((row) => row.id === activeResidentLeaseId) ?? residentLeaseRows[0] ?? null;
    }
    return residentLeaseRows[0] ?? null;
  }, [activeResidentLeaseId, residentLeaseRows]);

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

  const residentChargeCounts = useMemo(() => {
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
    return [...filtered].sort((a, b) => compareDueDateMs(a.dueDateSortMs, b.dueDateSortMs, direction));
  }, [residentLedgerRows, chargeBucket]);

  const selectedApplicationRow = useMemo<DemoApplicantRow | null>(() => {
    void hcTick;
    if (!selected) return null;
    return readManagerApplicationRows().find((row) => row.id === selected.id) ?? null;
  }, [selected, hcTick]);

  const applicationGroups = useMemo(() => {
    void hcTick;
    return buildApplicationGroups(readManagerApplicationRows().map(groupRowInputForRow));
  }, [hcTick]);

  const selectedApplicationGroup = useMemo(() => {
    if (!selectedApplicationRow) return null;
    return groupForRow(applicationGroups, { groupId: groupIdForRow(selectedApplicationRow) });
  }, [applicationGroups, selectedApplicationRow]);

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

  const residentDetailTabsAvailable = useMemo((): ResidentDetailTabId[] => {
    const tabs: ResidentDetailTabId[] = [];
    if (showResidentApplication) tabs.push("application");
    if (showResidentLease) tabs.push("lease");
    tabs.push("payments", "services", "communication");
    return tabs;
  }, [showResidentApplication, showResidentLease]);

  const resolvedDetailTab = residentDetailTabsAvailable.includes(activeDetailTab)
    ? activeDetailTab
    : (residentDetailTabsAvailable[0] ?? "payments");

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

  const residentServiceRequestsCounts = useMemo(() => {
    const c: Record<ManagerServiceRequestBucket, number> = { pending: 0, approved: 0, denied: 0 };
    for (const req of residentServiceRequests) c[managerServiceRequestBucket(req.status)] += 1;
    return c;
  }, [residentServiceRequests]);

  const residentFilteredServiceRequests = useMemo(
    () =>
      residentServiceRequests
        .filter((req) => managerServiceRequestBucket(req.status) === svcReqBucket)
        .slice()
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()),
    [residentServiceRequests, svcReqBucket],
  );

  const residentWorkOrderCounts = useMemo(() => {
    const c: Record<ManagerWorkOrderBucket, number> = { open: 0, scheduled: 0, completed: 0 };
    for (const row of residentWorkOrders) c[row.bucket] += 1;
    return c;
  }, [residentWorkOrders]);

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
            recipientEmail: selected.email.trim().toLowerCase(),
            recipientName: selected.name.trim(),
            senderPortal: "manager",
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
    } finally {
      setMessageBusy(false);
    }
  }

  function openResidentMessageModal(scheduleLater = true) {
    setMessageScheduleLater(scheduleLater);
    setMessageOpen(true);
  }

  async function sendResidentAccountEmail(
    res: ActiveResident,
    opts?: {
      channels?: { viaEmail?: boolean; viaSms?: boolean };
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
      const defaultBody = res.manuallyAdded
        ? buildExistingResidentWelcomeEmailBody({
            residentName: res.name,
            axisId: res.axisId,
            signupUrl,
            propertyLabel: res.propertyLabel,
          })
        : buildResidentWelcomeEmailBody({
            residentName: res.name,
            axisId: res.axisId,
            signupUrl,
          });
      const body = opts?.draft?.body?.trim() || defaultBody;
      const viaEmail = opts?.channels?.viaEmail !== false;
      const viaSms = opts?.channels?.viaSms === true;

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

      if (opts?.channels && (viaSms || viaEmail)) {
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
        }),
      });

      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; skipped?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        showToast(data.error ?? "Could not send lease signing reminder.");
        return;
      }

      appendLeaseThreadMessage(leaseId, "manager", "Sent lease-signing reminder to resident.", userId);
      setLeaseTick((n) => n + 1);
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

  function leaseSentToResidentBody(res: ActiveResident, lease: LeasePipelineRow): string {
    const unit = lease.unit.trim() || "your unit";
    return buildLeaseReadyForResidentMessage({
      residentName: lease.residentName || res.name || "there",
      residentEmail: res.email.trim(),
      unit,
      variant: "send",
    });
  }

  function openLeaseSendPreview(res: ActiveResident, lease: LeasePipelineRow) {
    if (!residentAccountEmails.has(res.email.trim().toLowerCase())) {
      showToast("Resident must create their account before the lease can be sent.");
      return;
    }
    if (!lease.generatedHtml && !lease.managerUploadedPdf?.dataUrl) {
      showToast("Generate or upload a lease document first.");
      return;
    }
    // Same refusals `sendLeaseToResident` makes, before the preview opens —
    // being refused at "Send lease & notification" reads as a broken send.
    const gateBlocker = leaseSendGateBlocker(lease);
    if (gateBlocker) {
      showToast(gateBlocker);
      // Only for the blockers the review can actually clear — the same scoping
      // as the "Review import" CTA. An unapproved applicant is fixed in
      // Applications, and a Confirm flow that still ends in the same refusal is
      // a dead end.
      if (leaseNeedsUploadedLeaseReviewAction(lease)) setImportReviewLeaseId(lease.id);
      return;
    }
    const recipient = res.email.trim();
    const unit = lease.unit.trim() || "your unit";
    setLeaseSentPreview({
      res,
      lease,
      recipient,
      subject: `Your lease for ${unit} is ready to sign`,
      body: leaseSentToResidentBody(res, lease),
    });
  }

  async function confirmSendLeaseToResident(
    skipMessage: boolean,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject: string; body: string },
  ) {
    if (!leaseSentPreview || leaseSendBusy) return;
    const { res, lease, subject, body } = leaseSentPreview;
    const messageSubject = draft?.subject ?? subject;
    const messageBody = draft?.body ?? body;
    setLeaseSendBusy(true);
    try {
      const sendResult = await sendLeaseToResident(lease.id, userId);
      if (!sendResult.ok) {
        showToast(sendResult.error ?? "Could not send lease.");
        return;
      }
      setLeaseSentPreview(null);
      appendLeaseThreadMessage(lease.id, "manager", "Sent lease to resident for review and signature.", userId);
      if (skipMessage) {
        showToast("Lease sent to resident portal (no notification sent).");
      } else {
        const notice = await deliverPortalInboxMessage({
          eventCategory: "leases",
          fromName: managerEmail ?? "Property Manager",
          toEmails: [res.email],
          subject: messageSubject,
          text: messageBody,
          deliverViaEmail: channels?.viaEmail !== false,
          deliverViaSms: channels?.viaSms === true,
        });
        if (notice.ok) {
          showToast(
            notice.skipped
              ? "Lease sent to resident portal (demo inbox only)."
              : "Lease sent to resident portal with inbox and email notification.",
          );
        } else {
          showToast("Lease sent to resident portal. Notification could not be delivered.");
        }
      }
      setLeaseTick((n) => n + 1);
    } finally {
      setLeaseSendBusy(false);
    }
  }

  const setApplicationBucket = async (
    id: string,
    nextBucket: ManagerApplicationBucket,
    opts?: { skipWelcomeEmail?: boolean },
  ) => {
    const result = await transitionApplicationBucket(id, nextBucket, {
      userId: userId ?? null,
      skipWelcomeEmail: opts?.skipWelcomeEmail,
    });
    if (!result) return;
    setHcTick((n) => n + 1);
    setLeaseTick((n) => n + 1);
    if (result.blocked) {
      showToast(result.message ?? "That change could not be saved.");
      return;
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
  };

  const deleteApplicationForRow = async (row: DemoApplicantRow) => {
    if (!window.confirm(`Delete the application for ${row.name || row.email}? This cannot be undone.`)) return;
    const email = row.email?.trim().toLowerCase();
    const nextRows = readManagerApplicationRows().filter((candidate) => candidate.id !== row.id);
    writeManagerApplicationRows(nextRows);
    setHcTick((n) => n + 1);

    let serverError: string | null = null;
    if (email || row.id) {
      try {
        const res = await fetch("/api/portal/delete-resident-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, purgeData: true, applicationId: row.id }),
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          serverError = body?.error ?? "Could not delete application.";
        }
      } catch {
        serverError = "Could not delete application.";
      }
    } else {
      const result = await deleteManagerApplicationFromServer(row.id);
      if (!result.ok) serverError = result.error ?? "Could not delete application.";
    }

    if (serverError) {
      void syncManagerApplicationsFromServer({ force: true, managerUserId: userId }).then(() => setHcTick((n) => n + 1));
      showToast(serverError);
      return;
    }

    showToast("Application deleted.");
    navigate(`${portalBase}/residents/${residentsTab}`);
  };

  const sendApplicationCompletionReminder = async (
    row: DemoApplicantRow,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
  ) => {
    if (applicationReminderBusyId) return;
    setApplicationReminderBusyId(row.id);
    try {
      if (isDemoModeActive()) {
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
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; mailtoHref?: string };
      if (res.ok && data.ok) {
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

  function resetAddResidentForm() {
    setArName("");
    setArEmail("");
    setArPhone("");
    setArPropertyId("");
    setArRoomId("");
    setArBundleId("");
    setArLeaseTerm("");
    setArLeaseTermCustomMode(false);
    setArMoveInDate("");
    setArMoveOutDate("");
    setArRent("");
    setArUtilities("");
    setArMoveInFee("");
    setArSecurityDeposit("");
    setArNotes("");
    setArSignedLeaseFileName("");
    setArSignedLeaseDataUrl("");
    setArPdfBusy(false);
    setArApplicationFile(null);
    setArLeaseImportFile(null);
    setArApplicationParse(null);
    setArLeaseParse(null);
    setAddResidentNoticePreview(null);
  }

  function buildManualResidentRow(): DemoApplicantRow | null {
    if (!arName.trim()) {
      showToast("Enter the resident's name.");
      return null;
    }
    if (!arEmail.trim()) {
      showToast("Enter the resident's email.");
      return null;
    }
    const rent = arRent.trim() ? Number(arRent.replace(/[^\d.]/g, "")) : null;
    const arAppLeaseFields = residentLeaseTermToApplicationFields(arLeaseTerm, arLeaseTermCustomMode, arPropertyId);
    const arSavingShortTerm = arAppLeaseFields.rentalType === "short_term";
    const utilities = arSavingShortTerm
      ? null
      : arUtilities.trim()
        ? Number(arUtilities.replace(/[^\d.]/g, ""))
        : null;
    const moveInFee = arMoveInFee.trim() ? Number(arMoveInFee.replace(/[^\d.]/g, "")) : null;
    const secDeposit = arSecurityDeposit.trim() ? Number(arSecurityDeposit.replace(/[^\d.]/g, "")) : null;
    const axisId = `PROPLANE-${Date.now().toString(36).toUpperCase().slice(-8)}`;
    const propLabel = arPropertyId
      ? (propertyOptions.find((p) => p.id === arPropertyId)?.label ?? arPropertyId)
      : "—";
    const placement = resolveManualResidentAssignment({
      propertyId: arPropertyId,
      roomId: arRoomId,
      bundleId: arBundleId,
    });
    const selectedRoomLabel = placement.placementLabel?.trim() || "";
    const signedLeaseUploadedAt = arSignedLeaseDataUrl.trim() ? new Date().toISOString() : undefined;
    const hasUploadedLeasePdf = Boolean(arSignedLeaseDataUrl.trim());
    return {
      id: axisId,
      name: arName.trim(),
      email: arEmail.trim(),
      property: propLabel,
      stage: "Active",
      bucket: "approved",
      detail: "",
      assignedPropertyId: arPropertyId || undefined,
      assignedRoomChoice: placement.assignedRoomChoice,
      signedMonthlyRent: rent ?? undefined,
      managerUserId: userId ?? undefined,
      manuallyAdded: true,
      manualResidentDetails: {
        phone: arPhone.trim() || undefined,
        moveInDate: arMoveInDate || undefined,
        moveOutDate: arMoveOutDate || undefined,
        monthlyUtilities: utilities ?? undefined,
        moveInFee: moveInFee ?? undefined,
        securityDeposit: secDeposit ?? undefined,
        roomNumber: selectedRoomLabel || undefined,
        leaseTerm: arLeaseTerm.trim() || undefined,
        notes: arNotes.trim() || undefined,
        signedLeaseFileName: arSignedLeaseFileName.trim() || undefined,
        signedLeaseDataUrl: arSignedLeaseDataUrl.trim() || undefined,
        signedLeaseUploadedAt,
        ...(hasUploadedLeasePdf ? { externallySignedLease: true as const } : {}),
      },
      application: arAppLeaseFields.leaseTerm
        ? ({
            propertyId: arPropertyId || undefined,
            roomChoice1: placement.assignedRoomChoice,
            bundleId: placement.bundleId,
            leaseTerm: arAppLeaseFields.leaseTerm,
            rentalType: arAppLeaseFields.rentalType,
            leaseStart: arMoveInDate || undefined,
            leaseEnd: arMoveOutDate || undefined,
            fullLegalName: arName.trim(),
            email: arEmail.trim(),
            phone: arPhone.trim() || undefined,
          } as unknown as DemoApplicantRow["application"])
        : undefined,
    };
  }

  function reviewManualResident() {
    const row = buildManualResidentRow();
    if (!row) return;
    setAddResidentNoticePreview(row);
  }

  function confirmManualResident(
    skipMessage: boolean,
    channels?: { viaEmail: boolean; viaSms: boolean },
    draft?: { subject: string; body: string; scheduleAt?: string },
  ) {
    void (async () => {
      const nextRow = addResidentNoticePreview;
      if (!nextRow || arSaving) return;
      setArSaving(true);
      try {
        appendManagerApplicationRow(nextRow, { skipServerMirror: true });
        const persisted = await upsertApplicationRowToServerAwait(nextRow, {
          existingResidentOnboarding: { sendWelcomeEmail: false },
        });
        if (!persisted.ok) {
          if (persisted.mailtoHref) {
            const { openMailtoHref } = await import("@/lib/resident-welcome-email");
            openMailtoHref(persisted.mailtoHref);
          }
          showToast(persisted.error ?? "Could not complete resident onboarding.");
          return;
        }
        recordApprovedApplicationCharges(nextRow, userId ?? null, true);
        syncLeasePipelineFromApplications(userId ?? null);

        await Promise.all([
          syncManagerApplicationsFromServer({ force: true, managerUserId: userId }),
          syncLeasePipelineFromServer(userId ?? null, { force: true }),
          syncHouseholdChargesFromServer(true),
        ]);
        setChargeBucket("pending");

        if (!skipMessage) {
          const signupUrl = residentAccountCreationUrl(window.location.origin, nextRow.id);
          const subject = draft?.subject?.trim() || EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT;
          const body =
            draft?.body?.trim() ||
            buildExistingResidentWelcomeEmailBody({
              residentName: nextRow.name,
              axisId: nextRow.id,
              signupUrl,
              propertyLabel: nextRow.property,
            });
          const viaEmail = channels?.viaEmail !== false;
          const viaSms = channels?.viaSms === true;

          if (draft?.scheduleAt) {
            const response = await fetch("/api/portal/scheduled-inbox-messages", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                subject,
                body,
                sendAt: draft.scheduleAt,
                deliverViaEmail: viaEmail,
                deliverViaSms: viaSms,
                recipientEmail: nextRow.email!.trim().toLowerCase(),
                recipientName: nextRow.name.trim(),
                senderPortal: "manager",
              }),
            });
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            if (!response.ok) {
              showToast(data.error ?? "Resident added, but the notice could not be scheduled.");
            } else {
              showToast(`Resident added. Portal setup notice scheduled for ${nextRow.email?.trim()}.`);
            }
          } else {
            const notice = await deliverPortalInboxMessage({
              eventCategory: "messages",
              toEmails: [nextRow.email!.trim().toLowerCase()],
              subject,
              text: body,
              deliverViaEmail: viaEmail,
              deliverViaSms: viaSms,
            });
            if (notice.ok) {
              showToast(
                notice.skipped
                  ? `Resident added. Notice saved to PropLane inbox for ${nextRow.email?.trim()}.`
                  : `Resident added. Portal setup notice sent to ${nextRow.email?.trim()}.`,
              );
            } else {
              showToast(notice.error ? `Resident added, but notice failed: ${notice.error}` : "Resident added, but notice could not be sent.");
            }
          }
        } else {
          showToast(`Resident added. PropLane ID: ${nextRow.id}`);
        }

        resetAddResidentForm();
        setAddResidentOpen(false);
        setHcTick((n) => n + 1);
        setLeaseTick((n) => n + 1);
      } finally {
        setArSaving(false);
      }
    })();
  }

  function openEditResidentModal() {
    if (!selected) return;
    const row = readManagerApplicationRows().find((r) => r.id === selected.id);
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
    setEditResidentOpen(true);
  }

  function saveEditedResident() {
    if (!selected || erSaving) return;
    if (!erName.trim()) {
      showToast("Enter the resident's name.");
      return;
    }
    const rows = readManagerApplicationRows();
    const idx = rows.findIndex((r) => r.id === selected.id);
    if (idx === -1) {
      showToast("Resident record not found.");
      return;
    }
    const rent = erRent.trim() ? Number(erRent.replace(/[^\d.]/g, "")) : null;
    const appLeaseFields = residentLeaseTermToApplicationFields(erLeaseTerm, erLeaseTermCustomMode, erPropertyId);
    const erSavingShortTerm = appLeaseFields.rentalType === "short_term";
    const utilities = erSavingShortTerm
      ? null
      : erUtilities.trim()
        ? Number(erUtilities.replace(/[^\d.]/g, ""))
        : null;
    const moveInFee = erMoveInFee.trim() ? Number(erMoveInFee.replace(/[^\d.]/g, "")) : null;
    const secDeposit = erSecurityDeposit.trim() ? Number(erSecurityDeposit.replace(/[^\d.]/g, "")) : null;
    const propId = erPropertyId.trim();
    const propLabel = propId ? propertyOptions.find((p) => p.id === propId)?.label ?? rows[idx]!.property : rows[idx]!.property;
    const placement = resolveManualResidentAssignment({
      propertyId: propId,
      roomId: erRoomId,
      bundleId: erBundleId,
    });
    const selectedRoomLabel = placement.placementLabel?.trim() || "";
    const existing = rows[idx]!;
    const newRoomChoice = placement.assignedRoomChoice;
    const baseApplication =
      existing.application ??
      (appLeaseFields.leaseTerm || propId || erEmail.trim() || erMoveInDate
        ? ({
            propertyId: propId || undefined,
            roomChoice1: newRoomChoice,
            bundleId: placement.bundleId ?? "",
            leaseTerm: appLeaseFields.leaseTerm,
            rentalType: appLeaseFields.rentalType,
            leaseStart: erMoveInDate || undefined,
            leaseEnd: erMoveOutDate || undefined,
            fullLegalName: erName.trim(),
            email: erEmail.trim(),
            phone: erPhone.trim() || undefined,
          } as DemoApplicantRow["application"])
        : undefined);
    let nextRow: DemoApplicantRow = {
      ...existing,
      name: erName.trim(),
      email: erEmail.trim() || existing.email,
      property: propLabel,
      assignedPropertyId: propId || undefined,
      assignedRoomChoice: newRoomChoice,
      signedMonthlyRent: rent ?? undefined,
      manualResidentDetails: {
        ...(existing.manualResidentDetails ?? {}),
        phone: erPhone.trim() || undefined,
        moveInDate: erMoveInDate || undefined,
        moveOutDate: erMoveOutDate || undefined,
        monthlyUtilities: utilities ?? undefined,
        moveInFee: moveInFee ?? undefined,
        securityDeposit: secDeposit ?? undefined,
        roomNumber: selectedRoomLabel || undefined,
        leaseTerm: erLeaseTerm.trim() || undefined,
        notes: erNotes.trim() || undefined,
      },
      application: baseApplication
        ? {
            ...baseApplication,
            fullLegalName: erName.trim() || baseApplication.fullLegalName,
            email: erEmail.trim() || baseApplication.email,
            phone: erPhone.trim() || baseApplication.phone,
            propertyId: propId || baseApplication.propertyId,
            roomChoice1: newRoomChoice ?? (placement.bundleId ? "" : baseApplication.roomChoice1),
            bundleId: placement.bundleId ?? "",
            leaseTerm: appLeaseFields.leaseTerm || baseApplication.leaseTerm,
            rentalType: appLeaseFields.leaseTerm ? appLeaseFields.rentalType : baseApplication.rentalType,
            leaseStart: erMoveInDate || baseApplication.leaseStart,
            leaseEnd: erMoveOutDate || baseApplication.leaseEnd,
            managerRentOverride: erRent.trim() || baseApplication.managerRentOverride,
            managerUtilitiesOverride: erSavingShortTerm
              ? ""
              : erUtilities.trim() || baseApplication.managerUtilitiesOverride,
            managerMoveInFeeOverride: erMoveInFee.trim() || baseApplication.managerMoveInFeeOverride,
            managerSecurityDepositOverride:
              erSecurityDeposit.trim() || baseApplication.managerSecurityDepositOverride,
          }
        : undefined,
    };
    if (nextRow.application) {
      nextRow = mergeApplicationLeaseDatesIntoResidentRow(nextRow, nextRow.application);
    }

    const next = [...rows];
    next[idx] = nextRow;
    setErSaving(true);
    void persistResidentProfileEdit({ rows: next, nextRow, managerUserId: userId ?? null })
      .then((result) => {
        if (!result.ok) {
          showToast(result.error ?? "Could not save resident.");
          return;
        }
        setEditResidentOpen(false);
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

  function openResidentPaymentSetup() {
    if (!selected) return;
    // `ActiveResident` has no `assignedPropertyId` — reading it here failed the
    // production type check. The fallback is already applied where these rows are
    // built (`row.assignedPropertyId || row.propertyId`), so `propertyId` carries
    // it and nothing is lost by dropping the duplicate.
    const propId = selected.propertyId.trim();
    if (!propId) {
      showToast("This resident isn't linked to a property yet.");
      return;
    }
    setResidentPaymentSetupOpen(true);
  }

  async function deleteSelectedResident() {
    if (!selected) return;
    const selectedResident = selected;
    if (!window.confirm(`Delete resident ${selectedResident.name || selectedResident.email}? This cannot be undone.`)) return;

    const allRows = readManagerApplicationRows();
    if (!allRows.some((row) => row.id === selectedResident.id)) {
      showToast("Resident not found.");
      return;
    }

    let serverDeleteError: string | null = null;
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
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        serverDeleteError = body?.error ?? "Could not delete resident.";
      }
    } catch {
      serverDeleteError = "Could not delete resident.";
    }

    if (serverDeleteError) {
      showToast(serverDeleteError);
      return;
    }

    writeManagerApplicationRows(allRows.filter((row) => row.id !== selectedResident.id));

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
    const deletedThreads = allInbox.filter((thread) => thread.email.trim().toLowerCase() === residentEmail);
    const nextInbox = allInbox.filter((thread) => thread.email.trim().toLowerCase() !== residentEmail);
    persistInbox(MANAGER_INBOX_STORAGE_KEY, nextInbox);
    for (const thread of deletedThreads) {
      void fetch("/api/portal-inbox-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "delete", id: thread.id }),
      }).catch(() => undefined);
    }

    await syncManagerApplicationsFromServer({ force: true, managerUserId: userId });
    navigate(`${portalBase}/residents/${residentsTab}`);
    setHcTick((n) => n + 1);
    setLeaseTick((n) => n + 1);
    setWorkOrderTick((n) => n + 1);
    setInboxTick((n) => n + 1);
    showToast("Resident and all related portal data deleted.");
  }

  function leaseGenerationGateTitle(row: LeasePipelineRow): string | undefined {
    const gate = leaseGenerationSupportedForRow(row);
    return gate.ok ? undefined : gate.error;
  }

  const uploadLeaseForSelectedResident = useCallback(
    async (file: File, rowId: string) => {
      if (!selected || !rowId) return;
      setUploadingLeaseRowId(rowId);
      const result = await uploadAndParseLeasePdf(rowId, file, userId);
      setUploadingLeaseRowId(null);
      if (!result.ok) {
        showToast(result.error ?? "Upload failed.");
        return;
      }
      setLeaseTick((n) => n + 1);
      if (result.saveError) {
        showToast(`Lease PDF uploaded, but its PropLane reading was not stored: ${result.saveError}`);
        return;
      }
      if (!result.parse) {
        showToast("Lease PDF uploaded.");
        return;
      }
      setImportReviewLeaseId(rowId);
      showToast(
        result.parse.status === "parsed"
          ? `Lease imported into PropLane format (${result.parse.sections.length} sections). ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`
          : `Lease PDF uploaded, but PropLane could not read its text. ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`,
      );
    },
    [selected, showToast, userId],
  );

  function openGenerateLeaseConfirm(rowId: string) {
    const row = readLeasePipeline(userId).find((r) => r.id === rowId);
    if (!row || !leaseAllowsManagerDocumentEdits(row) || !leaseGenerationSupportedForRow(row).ok) return;
    setRegenerateConfirmLeaseId(rowId);
  }

  const generateLeaseRow = regenerateConfirmLeaseId
    ? readLeasePipeline(userId).find((r) => r.id === regenerateConfirmLeaseId) ?? null
    : null;

  function signLeaseAsManager(row: LeasePipelineRow) {
    if (!residentHasSignedLease(row)) {
      showToast("The resident must sign the lease before you can countersign.");
      return;
    }
    setSigningLease(row);
  }

  async function handleManagerModalSign(signatureName: string, consentVersion: string) {
    if (!signingLease) return false;
    const ok = await managerSignLease(signingLease.id, signatureName.trim(), userId, consentVersion);
    if (ok) {
      setLeaseTick((n) => n + 1);
      showToast(
        hasBothLeaseSignatures({
          ...signingLease,
          managerSignature: { role: "manager", name: signatureName.trim(), signedAtIso: new Date().toISOString() },
        })
          ? "Lease fully signed."
          : "Manager signature saved.",
      );
      setSigningLease(null);
      return true;
    } else {
      showToast("Could not sign lease.");
      return false;
    }
  }

  const residentProfileHeaderActions = selected ? (
    <>
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="resident-email-setup"
        onClick={() => {
          const signupUrl = residentAccountCreationUrl(window.location.origin, selected.axisId);
          const previewBody = buildResidentWelcomeEmailBody({ residentName: selected.name, axisId: selected.axisId, signupUrl });
          setWelcomePreviewContent(previewBody);
          setWelcomePreviewFor(selected);
        }}
      >
        <span className="max-md:hidden">Email setup</span>
        <span className="md:hidden">Email</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="resident-edit"
        onClick={openEditResidentModal}
      >
        Edit
      </Button>
      <Button
        type="button"
        variant="outline"
        className={`${RESIDENT_DETAIL_HEADER_ACTION_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
        data-attr="resident-delete"
        onClick={deleteSelectedResident}
      >
        Delete
      </Button>
    </>
  ) : null;

  const residentApplicationTabFooterActions = selectedApplicationRow ? (
    applicationReviewView === "background-check" ? (
      <>
        {applicationShowsBackgroundCheck(selectedApplicationRow) &&
        Boolean(selectedApplicationRow.application?.consentCredit) &&
        selectedApplicationRow.backgroundCheck?.status !== "pending" &&
        selectedApplicationRow.backgroundCheck?.status !== "complete" ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="run-background-check"
            onClick={() => {
              setCheckrScreeningShowPicker(false);
              setCheckrScreeningRowId(selectedApplicationRow.id);
            }}
          >
            {isDemoModeActive() ? "Test" : "Run background check"}
          </Button>
        ) : null}
        {applicationShowsBackgroundCheck(selectedApplicationRow) &&
        Boolean(selectedApplicationRow.application?.consentCredit) &&
        selectedApplicationRow.backgroundCheck?.status === "complete" ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="run-background-check-again"
            onClick={() => {
              setCheckrScreeningShowPicker(true);
              setCheckrScreeningRowId(selectedApplicationRow.id);
            }}
          >
            Run again
          </Button>
        ) : null}
        {selectedApplicationRow.backgroundCheck?.status === "complete" ||
        (isDemoModeActive() && applicationShowsBackgroundCheck(selectedApplicationRow)) ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="screening-pdf-download"
            onClick={() => downloadBackgroundCheckForApplication(selectedApplicationRow)}
          >
            Download
          </Button>
        ) : null}
      </>
    ) : (
      <>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          data-attr="resident-application-edit"
          onClick={() => setApplicationEditOpen(true)}
        >
          Edit application
        </Button>
        {selectedApplicationRow.bucket !== "rejected" && !isWithdrawnApplicationRow(selectedApplicationRow) ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="application-holding-fee-open"
            onClick={() => setHoldingFeeRowId(selectedApplicationRow.id)}
          >
            Holding fee
          </Button>
        ) : null}
        {selectedApplicationRow.bucket === "pending" ? (
          <>
            {shouldOfferApplicationCompletionReminder(selectedApplicationRow) ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_DETAIL_BTN}
                data-attr="resident-application-send-reminder"
                disabled={applicationReminderPreviewBusyId !== null || applicationReminderBusyId !== null}
                onClick={() => openApplicationCompletionReminderPreview(selectedApplicationRow)}
              >
                {applicationReminderPreviewBusyId === selectedApplicationRow.id ? "Loading…" : "Send reminder"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              data-attr="resident-application-reject"
              onClick={() => setApplicationBucket(selectedApplicationRow.id, "rejected")}
            >
              Reject
            </Button>
            {!isInProgressApplicationRow(selectedApplicationRow) &&
            !isWithdrawnApplicationRow(selectedApplicationRow) ? (
              <Button
                type="button"
                variant="primary"
                className={PORTAL_DETAIL_BTN}
                data-attr="resident-application-approve"
                onClick={() => setApprovePreviewRow(selectedApplicationRow)}
              >
                Approve
              </Button>
            ) : null}
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="resident-application-move-pending"
            onClick={() => setApplicationBucket(selectedApplicationRow.id, "pending")}
          >
            <span className="max-md:hidden">To pending</span>
            <span className="md:hidden">Pending</span>
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          data-attr="resident-application-download-footer"
          onClick={() => {
            runApplicationPdfDownload(selectedApplicationRow, showToast);
          }}
        >
          Download
        </Button>
      </>
    )
  ) : null;

  const residentLeaseTabFooterActions =
    selected && residentLease ? (
      <LeasePrimaryHeaderActions
        embedded
        flatFooter
        btnClass={PORTAL_DETAIL_BTN}
        row={residentLease}
        downloadDataAttr="resident-lease-download"
        signManagerDataAttr="resident-lease-sign-manager"
        signingReminderDataAttr="resident-lease-signing-reminder"
        onDownload={() => runLeaseDownload(residentLease, showToast)}
        onSignManager={() => signLeaseAsManager(residentLease)}
        onSigningReminder={() => openLeaseSigningReminderPreview(selected, residentLease)}
        signingReminderBusy={leaseReminderBusy}
        sendToResidentDataAttr="resident-lease-send"
        moveToManagerReviewDataAttr="resident-lease-move-manager-review"
        onSendToResident={() => openLeaseSendPreview(selected, residentLease)}
        sendToResidentBusy={leaseSendBusy}
        // Deliberately never disabled for a blocked send: `openLeaseSendPreview`
        // states the reason and opens the review that clears it, and disabling
        // makes that unreachable. The gate is `sendLeaseToResident`, not the
        // button. Same reasoning as the Leases pipeline panel.
        sendToResidentDisabled={false}
        onMoveToManagerReview={() => {
          const moveResult = sendLeaseBackToManager(residentLease.id, userId);
          if (!moveResult.ok) {
            showToast(moveResult.error);
            return;
          }
          appendLeaseThreadMessage(
            residentLease.id,
            "manager",
            "Moved lease back to manager review.",
            userId,
          );
          setLeaseTick((n) => n + 1);
          showToast("Lease moved to Manager Review.");
        }}
        canEditDocument={leaseAllowsManagerDocumentEdits(residentLease)}
        generateLeaseDisabled={!leaseGenerationSupportedForRow(residentLease).ok}
        generateLeaseBusy={false}
        generateLeaseTitle={leaseGenerationGateTitle(residentLease)}
        onGenerateLease={() => openGenerateLeaseConfirm(residentLease.id)}
        onEditLease={
          leaseAllowsManagerGeneratedBodyEdits(residentLease)
            ? () => setEditResidentLeaseId(residentLease.id)
            : undefined
        }
        editLeaseDataAttr="resident-lease-edit"
        uploadPdfBusy={uploadingLeaseRowId === residentLease.id}
        onReviewImportedLease={() => setImportReviewLeaseId(residentLease.id)}
        onUploadPdf={async (file) => uploadLeaseForSelectedResident(file, residentLease.id)}
        deleteLabel="Delete lease"
        deleteDataAttr="resident-lease-delete"
        onDelete={() => {
          if (
            !window.confirm(
              `Delete the lease document for ${selected.name}? Generate or upload can recreate it.`,
            )
          ) {
            return;
          }
          if (deleteLeasePipelineRow(residentLease.id, userId)) {
            setLeaseTick((n) => n + 1);
            showToast("Lease document deleted.");
          } else {
            showToast("Could not delete lease document.");
          }
        }}
      />
    ) : null;

  const residentPaymentsListFooterActions = (
    <>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        onClick={() => setResidentReminderSettingsOpen(true)}
        data-attr="resident-payments-reminder-settings"
      >
        Reminders
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        onClick={openResidentPaymentSetup}
        data-attr="resident-payment-setup-open"
      >
        Payment setup
      </Button>
      <Button
        type="button"
        variant="primary"
        className={PORTAL_DETAIL_BTN}
        onClick={() => setAddResidentPaymentOpen(true)}
        data-attr="resident-add-payment"
      >
        Add payment
      </Button>
    </>
  );

  const residentServicesTabFooterActions = (
    <Button
      type="button"
      variant="primary"
      className={PORTAL_DETAIL_BTN}
      data-attr={svcSubTab === "requests" ? "resident-add-service-request" : "resident-add-work-order"}
      disabled={!canAddResidentServiceItem}
      title={
        canAddResidentServiceItem
          ? undefined
          : "Link this resident to a property before adding services."
      }
      onClick={() => {
        if (svcSubTab === "requests") setAddResidentRequestOpen(true);
        else setAddResidentWorkOrderOpen(true);
      }}
    >
      {svcSubTab === "requests" ? "Add service" : "Add work order"}
    </Button>
  );

  const residentDetailBottomBarActions = useMemo(() => {
    if (resolvedDetailTab === "application" && showResidentApplication) {
      return residentApplicationTabFooterActions;
    }
    if (resolvedDetailTab === "lease" && showResidentLease) {
      return residentLeaseTabFooterActions;
    }
    if (resolvedDetailTab === "payments") {
      if (paymentIdProp) return embeddedPaymentFooterActions;
      if (embeddedPaymentBulkActions) return embeddedPaymentBulkActions;
      return residentPaymentsListFooterActions;
    }
    if (resolvedDetailTab === "services") {
      return residentServicesTabFooterActions;
    }
    return null;
  }, [
    resolvedDetailTab,
    showResidentApplication,
    showResidentLease,
    residentApplicationTabFooterActions,
    residentLeaseTabFooterActions,
    paymentIdProp,
    embeddedPaymentFooterActions,
    embeddedPaymentBulkActions,
    residentPaymentsListFooterActions,
    residentServicesTabFooterActions,
  ]);

  useEffect(() => {
    if (resolvedDetailTab !== "payments") {
      setEmbeddedPaymentBulkActions(null);
    }
  }, [resolvedDetailTab]);

  const residentPaymentsListHref = selected
    ? residentDetailHref(portalBase, residentsTab, selected.id, "payments")
    : undefined;

  const residentDetailPanel =
    selected ? (
                          <div className="flex min-h-0 flex-1 flex-col gap-0">
                            <PortalPageChrome>
                            <PortalDetailDestinationNav
                                denseEqualRow
                                items={(
                                  [
                                    showResidentApplication ? "application" : null,
                                    showResidentLease ? "lease" : null,
                                    "payments",
                                    "services",
                                    "communication",
                                  ] as const
                                )
                                  .filter((tab): tab is ResidentDetailTabId => tab !== null)
                                  .map((tab) => ({
                                    id: tab,
                                    label: RESIDENT_DETAIL_TAB_LABELS[tab],
                                    shortLabel: RESIDENT_DETAIL_TAB_SHORT_LABELS[tab],
                                    href: residentDetailHref(portalBase, residentsTab, selected.id, tab),
                                    dataAttr: `resident-detail-tab-${tab}`,
                                  }))}
                                activeId={resolvedDetailTab}
                                ariaLabel="Resident profile sections"
                              />
                            </PortalPageChrome>

                            {resolvedDetailTab === "communication" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              <ManagerResidentDetailInbox
                                residentEmail={selected.email}
                                residentName={selected.name}
                                portalBase={portalBase}
                                smsUiEnabled={smsUiEnabled}
                                onNewMessage={() => openResidentMessageModal(false)}
                                scheduledRefreshKey={messageScheduledRefresh}
                              />
                            </ResidentDetailTabPanel>
                            </div>
                            ) : showResidentLease && resolvedDetailTab === "lease" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              {residentLeaseRows.length > 1 ? (
                                <div className="mb-3 shrink-0 -mx-2.5 bg-background sm:-mx-4 lg:mx-0">
                                  <LocalDestinationNav
                                    items={residentLeaseRows.map((row) => ({
                                      id: row.id,
                                      label: row.status ?? row.stageLabel ?? "Lease",
                                      dataAttr: `resident-lease-pick-${row.id}`,
                                    }))}
                                    activeId={residentLease?.id ?? residentLeaseRows[0]!.id}
                                    onChange={setActiveResidentLeaseId}
                                    ariaLabel="Resident leases"
                                    className="rounded-none border-0 border-b border-border bg-transparent p-0 md:rounded-2xl md:border md:border-border md:bg-accent/30 md:p-1"
                                  />
                                </div>
                              ) : null}
                              {residentLease ? (
                                <LeaseDocumentPreview
                                  row={residentLease}
                                  stretch
                                  className="min-h-0 flex-1"
                                  suppressApplicationDraft={Boolean(selected.manuallyAdded)}
                                  emptyHint="No lease document yet. Generate or upload one from Manager Review first."
                                />
                              ) : (
                                <p className="text-sm text-muted">
                                  {selectedApplicationRow?.bucket === "approved"
                                    ? "Add or upload a lease from the Leases section."
                                    : "Approve the application first, then add a lease from the Leases section."}
                                </p>
                              )}
                            </ResidentDetailTabPanel>
                            </div>
                            ) : showResidentApplication && resolvedDetailTab === "application" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                            <ResidentDetailTabPanel fill>
                              {selectedApplicationRow ? (
                                <div className="flex min-h-0 flex-1 flex-col gap-0">
                                  {selectedApplicationCosigners.length > 0 ? (
                                    <div className="shrink-0">
                                      <ApplicationCosignerSection
                                        submissions={selectedApplicationCosigners}
                                        primaryApplicationAxisId={selectedApplicationRow.id}
                                      />
                                    </div>
                                  ) : null}
                                  <ApplicationReviewLauncherRow
                                    row={selectedApplicationRow}
                                    group={selectedApplicationGroup}
                                    bareCanvas
                                    stretch
                                    showDownload={false}
                                    activeView={applicationReviewView}
                                    onActiveViewChange={setApplicationReviewView}
                                    onScreeningUpdated={handleScreeningUpdated}
                                    onOpenScreeningModal={(opts) => {
                                      setCheckrScreeningShowPicker(Boolean(opts?.showPackagePicker));
                                      setCheckrScreeningRowId(selectedApplicationRow.id);
                                    }}
                                    className="min-h-0 flex-1"
                                  />
                                </div>
                              ) : (
                                <p className="text-sm text-muted">No application on file for this resident.</p>
                              )}
                            </ResidentDetailTabPanel>
                            </div>
                            ) : (
                            <PortalPageScrollBody>

                            {resolvedDetailTab === "payments" ? (
                            <ResidentDetailTabPanel>
                              {paymentIdProp ? null : (
                                <SegmentedThree
                                  value={chargeBucket}
                                  onChange={(id) => setChargeBucket(id as ManagerPaymentBucket)}
                                  first={{ id: "pending", label: "Pending", count: residentChargeCounts.pending }}
                                  second={{ id: "overdue", label: "Overdue", count: residentChargeCounts.overdue }}
                                  third={{ id: "paid", label: "Paid", count: residentChargeCounts.paid }}
                                  className="mb-3 w-full"
                                />
                              )}
                              <ManagerPaymentsLedgerPanel
                                rows={paymentIdProp ? residentLedgerRows : residentLedgerRowsForBucket}
                                managerUserId={userId ?? null}
                                activeBucket={chargeBucket}
                                scheduledMessages={scheduledPaymentMessages}
                                reminderScheduleSummary={residentReminderScheduleSummary}
                                onOpenReminderSettings={() => setResidentReminderSettingsOpen(true)}
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
                                    ? (row) => residentPaymentDetailHref(portalBase, residentsTab, selected.id, row.id)
                                    : undefined
                                }
                                onEmbeddedDetailActions={handleEmbeddedPaymentFooterActions}
                                onEmbeddedBulkActions={handleEmbeddedPaymentBulkActions}
                                onAddPayment={() => setAddResidentPaymentOpen(true)}
                              />
                            </ResidentDetailTabPanel>
                            ) : null}

                            {resolvedDetailTab === "services" ? (
                            <ResidentDetailTabPanel>
                              <div className="-mx-2.5 mb-3 bg-background sm:-mx-4 lg:mx-0">
                                <LocalDestinationNav
                                  items={[
                                    { id: "requests", label: "Requests", dataAttr: "resident-services-tab-requests" },
                                    { id: "work-orders", label: "Work orders", dataAttr: "resident-services-tab-work-orders" },
                                  ]}
                                  activeId={svcSubTab}
                                  onChange={(id) => {
                                    setSvcSubTab(id as "requests" | "work-orders");
                                    setSvcExpandedId(null);
                                  }}
                                  ariaLabel="Resident services type"
                                  className="rounded-none border-0 border-b border-border bg-transparent p-0 md:rounded-2xl md:border md:border-border md:bg-accent/30 md:p-1"
                                />
                              </div>

                              {svcSubTab === "requests" ? (
                                <div>
                                  <div className="mb-3">
                                    <LocalDestinationNav
                                      items={(
                                        ["pending", "approved", "denied"] as const
                                      ).map((id) => ({
                                        id,
                                        label: id === "pending" ? "Pending" : id === "approved" ? "Approved" : "Denied",
                                        count: residentServiceRequestsCounts[id],
                                        dataAttr: `resident-service-request-bucket-${id}`,
                                      }))}
                                      activeId={svcReqBucket}
                                      onChange={(id) => setSvcReqBucket(id as ManagerServiceRequestBucket)}
                                      ariaLabel="Request status"
                                      size="toolbar"
                                    />
                                  </div>
                                  {residentServiceRequests.length === 0 ? (
                                    <PortalDataTableEmpty message="No requests yet." icon="service" />
                                  ) : residentFilteredServiceRequests.length === 0 ? (
                                    <PortalDataTableEmpty message="No requests in this status yet." icon="service" />
                                  ) : (
                                    <div className={`mt-3 ${PORTAL_DATA_TABLE_WRAP}`}>
                                      <div className={`${PORTAL_DATA_TABLE_SCROLL} overflow-x-auto`}>
                                        <table className="w-full min-w-[28rem] table-fixed border-collapse text-left text-sm lg:min-w-0">
                                          <thead>
                                            <tr className={PORTAL_TABLE_HEAD_ROW}>
                                              <th className={`${MANAGER_TABLE_TH} hidden text-left sm:table-cell`}>Type</th>
                                              <th className={`${MANAGER_TABLE_TH} text-left`}>Item</th>
                                              <th className={`${MANAGER_TABLE_TH} text-left`}>Status</th>
                                              <th className={`${MANAGER_TABLE_TH} hidden text-left sm:table-cell`}>Charges</th>
                                              <th className={PORTAL_TABLE_EXPAND_TH}>
                                                <span className="sr-only">Expand</span>
                                              </th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {residentFilteredServiceRequests.map((req) => {
                                              const rowId = `request-${req.id}`;
                                              return (
                                                <Fragment key={rowId}>
                                                  <tr
                                                    className={PORTAL_TABLE_TR_EXPANDABLE}
                                                    onClick={createPortalRowExpandClick(() =>
                                                      setSvcExpandedId((c) => (c === rowId ? null : rowId)),
                                                    )}
                                                    aria-expanded={svcExpandedId === rowId}
                                                  >
                                                    <td className={`${PORTAL_TABLE_TD} hidden text-muted sm:table-cell`}>Request</td>
                                                    <td className={`${PORTAL_TABLE_TD} min-w-0 font-medium text-foreground`}>
                                                      <span className="block text-xs text-muted sm:hidden">Request</span>
                                                      <span className="break-words">{req.offerName}</span>
                                                    </td>
                                                    <td className={PORTAL_TABLE_TD}>
                                                      <ServiceStatusBadge status={req.status} />
                                                    </td>
                                                    <td className={`${PORTAL_TABLE_TD} hidden sm:table-cell`}>
                                                      {managerServiceRequestPricingSummary(req)}
                                                    </td>
                                                    <PortalTableExpandCell expanded={svcExpandedId === rowId} />
                                                  </tr>
                                                  {svcExpandedId === rowId ? (
                                                    <tr className={PORTAL_TABLE_DETAIL_ROW}>
                                                      <td colSpan={5} className={PORTAL_TABLE_DETAIL_CELL}>
                                                        <ManagerServiceRequestDetail
                                                          req={req}
                                                          propertyLabel={selected.propertyLabel || "—"}
                                                          onUpdated={() => setSrTick((n) => n + 1)}
                                                          onApproved={() => setSvcReqBucket("approved")}
                                                          onDenied={() => setSvcReqBucket("denied")}
                                                          onCollapsed={() => setSvcExpandedId(null)}
                                                        />
                                                      </td>
                                                    </tr>
                                                  ) : null}
                                                </Fragment>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div>
                                  <div className="mb-3">
                                    <LocalDestinationNav
                                      items={(
                                        ["open", "scheduled", "completed"] as const
                                      ).map((id) => ({
                                        id,
                                        label: id === "open" ? "Pending" : id === "scheduled" ? "Scheduled" : "Completed",
                                        count: residentWorkOrderCounts[id],
                                        dataAttr: `resident-work-order-bucket-${id}`,
                                      }))}
                                      activeId={svcWoBucket}
                                      onChange={(id) => setSvcWoBucket(id as ManagerWorkOrderBucket)}
                                      ariaLabel="Work order status"
                                      size="toolbar"
                                    />
                                  </div>
                                  <ManagerWorkOrdersPanel
                                    allRows={residentWorkOrders}
                                    bucket={svcWoBucket}
                                    onAfterSchedule={() => setSvcWoBucket("scheduled")}
                                  />
                                </div>
                              )}
                            </ResidentDetailTabPanel>
                            ) : null}

                            </PortalPageScrollBody>
                            )}

                            {residentDetailBottomBarActions ? (
                              <PortalPageFooterActions pinned rowVariant="header">
                                <ResidentDocumentsDetailFooter>
                                  {residentDetailBottomBarActions}
                                </ResidentDocumentsDetailFooter>
                              </PortalPageFooterActions>
                            ) : null}
                          </div>
    ) : null;

  const residentsAddButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
      onClick={() => setAddResidentOpen(true)}
    >
      Add
    </Button>
  );

  const residentsFilterSheet =
    propertyOptions.length > 0 ? (
      <PortalFilterSortSheet
        activeCount={portalFilterActiveCount([propertyFilters])}
        compactPanel
        filterFieldCount={1}
        constrainDropdownToTitleBand
        mobileFlushBody
        className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
        onReset={() => setPropertyFilters([])}
        dataAttr="residents-filter-sheet-open"
      >
        <ApplicationFilterSortFields
          propertyOptions={propertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={setPropertyFilters}
          dataAttr="residents-filter-property"
        />
      </PortalFilterSortSheet>
    ) : null;

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
          onClose={() => setSigningLease(null)}
        />
      ) : null}
      {editResidentLeaseId && residentLeaseRows.find((row) => row.id === editResidentLeaseId) ? (
        <ManagerPipelineLeaseEditModal
          open
          row={residentLeaseRows.find((row) => row.id === editResidentLeaseId)!}
          onClose={() => setEditResidentLeaseId(null)}
          onDone={() => {
            void syncLeasePipelineFromServer(userId, { force: true }).then(() => setLeaseTick((n) => n + 1));
          }}
        />
      ) : null}
      {importReviewLease?.uploadedLeaseParse ? (
        <UploadedLeaseReviewModal
          open
          row={importReviewLease}
          parse={importReviewLease.uploadedLeaseParse}
          onClose={() => setImportReviewLeaseId(null)}
          onConfirm={({ overrides, note }) => {
            const result = confirmUploadedLeaseParse(importReviewLease.id, {
              managerUserId: userId,
              overrides: overrides as Partial<Record<UploadedLeaseFieldKey, string>>,
              note,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not confirm the imported lease.");
              return;
            }
            setLeaseTick((n) => n + 1);
            setImportReviewLeaseId(null);
            showToast("Imported lease confirmed. It can now be sent for signature.");
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
          subtitle={selected.email || undefined}
          avatarName={selected.name || selected.email}
          backHref={`${portalBase}/residents/${residentsTab}`}
          backLabel="Back to residents"
          hideBackText
          bareHeader
          dataAttrBack="resident-detail-back"
          actions={residentProfileHeaderActions}
          inlineActions
          // Communication is a fill-height chat; the lease and application tabs scroll
          // the document inside a bounded preview frame. Without fillBody both overflow a
          // clipped portal surface with no way to reach the rest of the document.
          pinScrollBody
          scrollBody={false}
          fillBody={
            resolvedDetailTab === "communication" ||
            (showResidentLease && resolvedDetailTab === "lease") ||
            (showResidentApplication && resolvedDetailTab === "application")
          }
        >
          {residentDetailPanel}
        </PortalRecordDetailPage>
      ) : (
      <ManagerPortalPageShell
        title="Residents"
        hideTitleOnMobileNav
        titleInlineFilter={residentsFilterSheet}
        titleAside={residentsAddButton}
        compactFilterRow
      >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: "Search residents",
          dataAttr: "residents-search",
        }}
      />
      {filtered.length === 0 ? (
        <div className="space-y-3 px-3 py-2">
          {residents.length > 0 ? (
            <PortalDataTableEmpty
              icon="residents"
              message={
                searchQuery.trim()
                  ? "No residents match your search."
                  : "No residents match this filter."
              }
            />
          ) : null}
          <PortalListAddRow
            label="Add"
            icon={PORTAL_LIST_ADD_ICONS.resident}
            onClick={() => setAddResidentOpen(true)}
            dataAttr="residents-list-add"
          />
        </div>
      ) : (
        <div className={PORTAL_LIST_PAGE_BODY}>
          {residentListClusters.map((cluster) => {
            const renderResidentRow = (res: ActiveResident) => {
              const housingLabel = [res.roomLabel, !propertyFilters.length ? res.propertyLabel : null]
                .filter(Boolean)
                .join(" · ");
              return (
                <PortalPersonRecordRow
                  key={res.id}
                  name={res.name || "—"}
                  subtitle={housingLabel || undefined}
                  preview={res.email || housingLabel || " "}
                  meta={res.leaseStart ? shortDateLabel(res.leaseStart) : undefined}
                  onOpen={() =>
                    navigate(residentDetailHref(portalBase, residentsTab, res.id, resolvedDetailTab))
                  }
                  dataAttr="resident-list-row"
                />
              );
            };

            if (!cluster.groupId) return cluster.rows.map(renderResidentRow);

            return (
              <ApplicationHouseholdCluster
                key={cluster.groupId}
                header={
                  <span className="truncate text-xs font-semibold text-foreground">
                    {groupHouseLabel(cluster.property, cluster.ordinal)}
                  </span>
                }
              >
                {cluster.rows.map(renderResidentRow)}
              </ApplicationHouseholdCluster>
            );
          })}
          <div className="px-3 py-3 max-md:px-2.5">
            <PortalListAddRow
              label="Add"
              icon={PORTAL_LIST_ADD_ICONS.resident}
              onClick={() => setAddResidentOpen(true)}
              dataAttr="residents-list-add"
            />
          </div>
        </div>
      )}

      </ManagerPortalPageShell>
      )}

      <ReminderSettingsModal
        open={residentReminderSettingsOpen}
        onClose={() => setResidentReminderSettingsOpen(false)}
        settings={residentReminderSettings}
        onSaved={(next) => {
          setResidentReminderSettings(next);
          void reloadResidentPaymentSchedule();
          setResidentReminderSettingsOpen(false);
        }}
      />
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

      <ManagerCreateServiceRequestModal
        open={addResidentRequestOpen}
        onClose={() => setAddResidentRequestOpen(false)}
        managerUserId={userId ?? null}
        defaultResident={selectedServiceResident}
        onSubmitted={() => {
          setAddResidentRequestOpen(false);
          setSrTick((n) => n + 1);
          setHcTick((n) => n + 1);
          setSvcReqBucket("pending");
        }}
      />

      <ManagerCreateWorkOrderModal
        open={addResidentWorkOrderOpen}
        onClose={() => setAddResidentWorkOrderOpen(false)}
        managerUserId={userId ?? null}
        defaultResident={selectedServiceResident}
        onSubmitted={(bucket) => {
          setAddResidentWorkOrderOpen(false);
          setWorkOrderTick((n) => n + 1);
          setHcTick((n) => n + 1);
          setSvcWoBucket(bucket);
        }}
      />

      <ManagerPaymentSetupModal
        open={residentPaymentSetupOpen}
        onClose={() => {
          setResidentPaymentSetupOpen(false);
          setPropertyTick((n) => n + 1);
          setHcTick((n) => n + 1);
        }}
        portalBase={portalBase}
        propertyOptions={propertyOptions}
        presetPropertyIds={selected?.propertyId.trim() ? [selected.propertyId.trim()] : undefined}
      />

      <Modal
        open={addResidentOpen && addResidentNoticePreview === null}
        title="Add resident"
        onClose={() => {
          resetAddResidentForm();
          setAddResidentOpen(false);
        }}
        footer={
          <ModalFooter>
            <Button type="button" variant="primary" className="rounded-full" onClick={reviewManualResident} disabled={arSaving}>
              Review & add resident
            </Button>
          </ModalFooter>
        }
      >
        <div className="min-w-0 max-w-full space-y-3 overflow-x-hidden">
          <div className="grid grid-cols-1 gap-3 min-[28rem]:grid-cols-2">
            <PropertyResidentPdfUploadCard
              title="Add application"
              subtitle="Rental application PDF"
              fileName={arApplicationFile?.name ?? null}
              busy={arPdfBusy}
              dataAttr="residents-add-application-pdf"
              onPick={() => arApplicationUploadRef.current?.click()}
            />
            <PropertyResidentPdfUploadCard
              title="Add lease"
              subtitle="Signed or draft lease PDF"
              fileName={arLeaseImportFile?.name ?? null}
              busy={arPdfBusy}
              dataAttr="residents-add-lease-pdf"
              onPick={() => arLeaseImportUploadRef.current?.click()}
            />
          </div>
          <input
            ref={arApplicationUploadRef}
            type="file"
            accept="application/pdf"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!acceptAddResidentPdfFile(file, e.currentTarget)) return;
              void handleAddResidentApplicationPdf(file);
            }}
          />
          <input
            ref={arLeaseImportUploadRef}
            type="file"
            accept="application/pdf"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!acceptAddResidentPdfFile(file, e.currentTarget)) return;
              void handleAddResidentLeasePdf(file);
            }}
          />
          <p className="text-xs text-muted">
            Upload one or both. Parsed fields appear below — edit anything before importing.
          </p>
          <p className="text-xs text-muted">
            Onboard an existing tenant: creates an active resident record, sets up payments, and can email portal instructions (no application or screening).
          </p>
          <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Full name *</span>
              <Input value={arName} onChange={(e) => setArName(e.target.value)} placeholder="Jane Smith" />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Email *</span>
              <Input type="email" value={arEmail} onChange={(e) => setArEmail(e.target.value)} placeholder="jane@example.com" />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Phone</span>
              <Input type="tel" value={arPhone} onChange={(e) => setArPhone(e.target.value)} placeholder="(555) 555-0100" />
            </label>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <PortalFormSingleSelect
                label="Property"
                labelClassName="font-medium text-muted"
                value={arPropertyId}
                onChange={(next) => {
                  setArPropertyId(next);
                  setArRoomId("");
                  setArBundleId("");
                }}
                options={propertyOptions.map((p) => ({ value: p.id, label: p.label }))}
                placeholder="Select property…"
                dataAttr="add-resident-property"
              />
            </div>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Lease term</span>
              <Select
                value={arLeaseTermSelectValue}
                onChange={(e) => {
                  const selected = e.target.value;
                  if (selected === RESIDENT_LEASE_TERM_CUSTOM) {
                    setArLeaseTermCustomMode(true);
                    if (arLeaseTermPresetValues.includes(arLeaseTerm)) {
                      setArLeaseTerm("");
                    }
                    return;
                  }
                  setArLeaseTermCustomMode(false);
                  setArLeaseTerm(selected);
                }}
              >
                <option value="">Select…</option>
                {arLeaseTermOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
              {arLeaseTermSelectValue === RESIDENT_LEASE_TERM_CUSTOM ? (
                <Input
                  className="mt-2"
                  value={arLeaseTerm}
                  onChange={(e) => setArLeaseTerm(e.target.value)}
                  placeholder="e.g. 9 months"
                />
              ) : null}
            </label>
            {arShowBundleSelect ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Lease bundle</span>
                <Select
                  value={arBundleId}
                  disabled={!arPropertyId || !arLeaseTerm}
                  onChange={(e) => {
                    const next = e.target.value;
                    setArBundleId(next);
                    if (next) setArRoomId("");
                  }}
                >
                  <option value="">
                    {arIsShortTermStay
                      ? "None: standard short-term stay"
                      : `None: ${arRentedByRoom ? "assign an individual room" : "standard lease"}`}
                  </option>
                  {arBundleOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-muted">
                  {arRentedByRoom
                    ? "Choose a bundle instead of a single room, or leave as none."
                    : "Optional bundle pricing for this listing."}
                </p>
              </label>
            ) : null}
            {arShowRoomSelect ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Room</span>
                <Select
                  value={arRoomId}
                  onChange={(e) => {
                    setArRoomId(e.target.value);
                    setArBundleId("");
                  }}
                >
                  <option value="">Select room…</option>
                  {arRoomOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {residentRoomRentSuffix(r, arIsShortTermStay)}
                    </option>
                  ))}
                </Select>
              </label>
            ) : arShowRoomSetupNote ? (
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Room</span>
                <p className="rounded-xl border border-dashed border-border bg-accent/30 px-3 py-2 text-xs text-muted">
                  Add rooms to this property in listing setup to assign a resident room here.
                </p>
              </div>
            ) : arShowWholeUnitPlacementNote ? (
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Placement</span>
                <p className="rounded-xl border border-dashed border-border bg-accent/30 px-3 py-2 text-xs text-muted">
                  {arEntireHome
                    ? "This property is leased as one home — no room assignment."
                    : "This property is leased as one unit — no room assignment."}
                </p>
              </div>
            ) : null}
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">{arIsShortTermStay ? "Rent / night ($)" : "Monthly rent ($)"}</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={arRent}
                onChange={(e) => setArRent(e.target.value)}
                placeholder={arIsShortTermStay ? "85.00" : "875.00"}
              />
              {arStayPreview ? <span className="text-xs text-muted">{arStayPreview}</span> : null}
            </label>
            {!arIsShortTermStay ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Monthly utilities ($)</span>
                <Input type="number" min={0} step={0.01} value={arUtilities} onChange={(e) => setArUtilities(e.target.value)} placeholder="175.00" />
              </label>
            ) : null}
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Move-in fee ($)</span>
              <Input type="number" min={0} step={0.01} value={arMoveInFee} onChange={(e) => setArMoveInFee(e.target.value)} placeholder="200.00" />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">{arIsShortTermStay ? "Deposit ($)" : "Security deposit ($)"}</span>
              <Input type="number" min={0} step={0.01} value={arSecurityDeposit} onChange={(e) => setArSecurityDeposit(e.target.value)} placeholder="875.00" />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Move-in date</span>
              <Input
                type="date"
                className="portal-modal-date-input"
                value={arMoveInDate}
                onChange={(e) => setArMoveInDate(e.target.value)}
              />
            </label>
            {!isMonthToMonthLease ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Move-out date</span>
                <Input
                  type="date"
                  className="portal-modal-date-input"
                  value={arMoveOutDate}
                  onChange={(e) => setArMoveOutDate(e.target.value)}
                />
              </label>
            ) : null}
            <label className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
              <span className="font-medium text-muted">Notes</span>
              <Textarea
                className="min-h-[72px]"
                value={arNotes}
                onChange={(e) => setArNotes(e.target.value)}
                placeholder="Any additional details about this resident…"
              />
            </label>
          </div>
        </div>
      </Modal>

      <PortalNotificationPreviewModal
        open={addResidentNoticePreview !== null}
        title="Add resident — notification preview"
        onClose={() => setAddResidentNoticePreview(null)}
        recipient={addResidentNoticePreview?.email ?? ""}
        recipientPhone={
          addResidentNoticePreview?.manualResidentDetails?.phone?.trim() ||
          addResidentNoticePreview?.application?.phone?.trim() ||
          ""
        }
        subject={EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT}
        body={
          addResidentNoticePreview
            ? buildExistingResidentWelcomeEmailBody({
                residentName: addResidentNoticePreview.name,
                axisId: addResidentNoticePreview.id,
                signupUrl: residentAccountCreationUrl(window.location.origin, addResidentNoticePreview.id),
                propertyLabel: addResidentNoticePreview.property,
              })
            : ""
        }
        intro="Review the portal setup message before creating this resident record."
        showChannelPicker
        showSchedule
        emailAvailable={Boolean(addResidentNoticePreview?.email?.includes("@"))}
        smsAvailable={Boolean(
          addResidentNoticePreview?.manualResidentDetails?.phone?.trim() ||
            addResidentNoticePreview?.application?.phone?.trim(),
        )}
        defaultViaSms={false}
        confirmLabel="Add resident & send notice"
        confirmLabelWithoutMessage="Add resident only"
        confirmBusy={arSaving}
        confirmBusyLabel="Adding…"
        cancelLabel="Back"
        onConfirm={(skipMessage, channels, draft) => void confirmManualResident(skipMessage, channels, draft)}
      />

      <Modal
        open={editResidentOpen}
        title="Edit resident"
        onClose={() => setEditResidentOpen(false)}
        assistantStrip={false}
        scrollableContent
        footer={
          <ModalFooter>
            <Button type="button" variant="primary" className="rounded-full" disabled={erSaving} onClick={saveEditedResident}>
              {erSaving ? "Saving…" : "Save resident"}
            </Button>
          </ModalFooter>
        }
      >
        <div className="min-w-0 max-w-full space-y-3 overflow-x-hidden pb-1">
          <p className="text-xs text-muted">Changes here update the resident record and application simultaneously.</p>
          {erIsShortTermStay ? (
            <p className="text-xs text-muted">Short-term stays use an all-in nightly rate — no separate utilities.</p>
          ) : null}
          <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Full name *</span>
              <Input value={erName} onChange={(e) => setErName(e.target.value)} placeholder="Jane Smith" />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Email</span>
              <Input type="email" value={erEmail} onChange={(e) => setErEmail(e.target.value)} placeholder="resident@email.com" />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Phone</span>
              <Input type="tel" value={erPhone} onChange={(e) => setErPhone(e.target.value)} placeholder="(555) 555-0100" />
            </label>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <PortalFormSingleSelect
                label="Property"
                labelClassName="font-medium text-muted"
                value={erPropertyId}
                onChange={(next) => {
                  setErPropertyId(next);
                  setErRoomId("");
                  setErBundleId("");
                }}
                options={propertyOptions.map((p) => ({ value: p.id, label: p.label }))}
                placeholder="Select property…"
                dataAttr="edit-resident-property"
              />
            </div>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Lease term</span>
              <NativeSelect
                value={erLeaseTermSelectValue}
                onChange={(e) => {
                  const selected = e.target.value;
                  if (selected === RESIDENT_LEASE_TERM_CUSTOM) {
                    setErLeaseTermCustomMode(true);
                    if (erLeaseTermPresetValues.includes(erLeaseTerm)) {
                      setErLeaseTerm("");
                    }
                    return;
                  }
                  setErLeaseTermCustomMode(false);
                  setErLeaseTerm(selected);
                }}
              >
                <option value="">Select…</option>
                {erLeaseTermOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </NativeSelect>
              {erLeaseTermSelectValue === RESIDENT_LEASE_TERM_CUSTOM ? (
                <Input
                  className="mt-2"
                  value={erLeaseTerm}
                  onChange={(e) => setErLeaseTerm(e.target.value)}
                  placeholder="e.g. 9 months"
                />
              ) : null}
            </label>
            {erShowBundleSelect ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Lease bundle</span>
                <NativeSelect
                  value={erBundleId}
                  disabled={!erPropertyId || !erLeaseTerm}
                  onChange={(e) => {
                    const next = e.target.value;
                    setErBundleId(next);
                    if (next) setErRoomId("");
                  }}
                >
                  <option value="">
                    {erIsShortTermStay
                      ? "None: standard short-term stay"
                      : `None: ${erRentedByRoom ? "assign an individual room" : "standard lease"}`}
                  </option>
                  {erBundleOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
                <p className="mt-1 text-xs text-muted">
                  {erRentedByRoom
                    ? "Choose a bundle instead of a single room, or leave as none."
                    : "Optional bundle pricing for this listing."}
                </p>
              </label>
            ) : null}
            {erShowRoomSelect ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Room</span>
                <NativeSelect
                  value={erRoomId}
                  onChange={(e) => {
                    setErRoomId(e.target.value);
                    setErBundleId("");
                  }}
                >
                  <option value="">Select room…</option>
                  {erRoomOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {residentRoomRentSuffix(r, erIsShortTermStay)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : erShowRoomSetupNote ? (
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Room</span>
                <p className="rounded-xl border border-dashed border-border bg-accent/30 px-3 py-2 text-xs text-muted">
                  Add rooms to this property in listing setup to assign a resident room here.
                </p>
              </div>
            ) : erShowWholeUnitPlacementNote ? (
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Placement</span>
                <p className="rounded-xl border border-dashed border-border bg-accent/30 px-3 py-2 text-xs text-muted">
                  {erEntireHome
                    ? "This property is leased as one home — no room assignment."
                    : "This property is leased as one unit — no room assignment."}
                </p>
              </div>
            ) : null}
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">{erIsShortTermStay ? "Rent / night ($)" : "Monthly rent ($)"}</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={erRent}
                onChange={(e) => setErRent(e.target.value)}
                placeholder={erIsShortTermStay ? "85.00" : "875.00"}
              />
              {erStayPreview ? <span className="text-xs text-muted">{erStayPreview}</span> : null}
            </label>
            {!erIsShortTermStay ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Monthly utilities ($)</span>
                <Input type="number" min={0} step={0.01} value={erUtilities} onChange={(e) => setErUtilities(e.target.value)} placeholder="175.00" />
              </label>
            ) : null}
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Move-in fee ($)</span>
              <Input type="number" min={0} step={0.01} value={erMoveInFee} onChange={(e) => setErMoveInFee(e.target.value)} placeholder="200.00" />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">{erIsShortTermStay ? "Deposit ($)" : "Security deposit ($)"}</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={erSecurityDeposit}
                onChange={(e) => setErSecurityDeposit(e.target.value)}
                placeholder="875.00"
              />
            </label>
            <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <span className="font-medium text-muted">Move-in date</span>
              <Input
                type="date"
                className="portal-modal-date-input"
                value={erMoveInDate}
                onChange={(e) => setErMoveInDate(e.target.value)}
              />
            </label>
            {!isEditMonthToMonthLease ? (
              <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <span className="font-medium text-muted">Move-out date</span>
                <Input
                  type="date"
                  className="portal-modal-date-input"
                  value={erMoveOutDate}
                  onChange={(e) => setErMoveOutDate(e.target.value)}
                />
              </label>
            ) : null}
            <label className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
              <span className="font-medium text-muted">Notes</span>
              <Textarea
                className="min-h-[72px]"
                value={erNotes}
                onChange={(e) => setErNotes(e.target.value)}
                placeholder="Any additional details about this resident…"
              />
            </label>
          </div>
        </div>
      </Modal>

      <Modal
        open={applicationEditOpen && Boolean(selectedApplicationRow?.application)}
        title={
          selectedApplicationRow
            ? `Edit application · ${selectedApplicationRow.name || selected?.name || "Resident"}`
            : "Edit application"
        }
        onClose={() => setApplicationEditOpen(false)}
        panelClassName="max-w-4xl w-full"
      >
        {selectedApplicationRow?.application ? (
          <ResidentApplicationEditor
            row={selectedApplicationRow}
            residentEmail={(selectedApplicationRow.email ?? selected?.email ?? "").trim().toLowerCase()}
            preserveReviewStatus
            onCancel={() => setApplicationEditOpen(false)}
            onSaved={async (savedRow) => {
              setApplicationEditOpen(false);
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

      <PortalNotificationPreviewModal
        open={approvePreviewRow !== null}
        title="Approve application: account setup email"
        onClose={() => setApprovePreviewRow(null)}
        recipient={approvePreviewRow?.email ?? ""}
        subject={RESIDENT_WELCOME_EMAIL_SUBJECT}
        body={
          approvePreviewRow
            ? buildResidentWelcomeEmailBody({
                residentName: approvePreviewRow.name || undefined,
                axisId: approvePreviewRow.id,
                signupUrl: residentAccountCreationUrl("", approvePreviewRow.id),
              })
            : ""
        }
        intro={
          approvePreviewRow
            ? `Approving ${approvePreviewRow.name || approvePreviewRow.email} will update their application status and can send their PropLane resident account setup email.`
            : undefined
        }
        confirmLabel="Approve & send setup email"
        confirmLabelWithoutMessage="Approve only"
        confirmBusy={approvePreviewRow !== null && approveBusyId === approvePreviewRow.id}
        confirmBusyLabel="Approving…"
        onConfirm={(skipMessage) => {
          if (!approvePreviewRow) return;
          const row = approvePreviewRow;
          setApprovePreviewRow(null);
          setApproveBusyId(row.id);
          void setApplicationBucket(row.id, "approved", { skipWelcomeEmail: skipMessage }).finally(() =>
            setApproveBusyId(null),
          );
        }}
      />

      <PortalNotificationPreviewModal
        open={welcomePreviewFor !== null}
        title="Email account setup · preview"
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
        showSchedule
        smsAvailable={Boolean(
          welcomePreviewFor &&
            (() => {
              const row = readManagerApplicationRows().find((r) => r.id === welcomePreviewFor.id);
              return Boolean(row?.manualResidentDetails?.phone?.trim() || row?.application?.phone?.trim());
            })(),
        )}
        defaultViaSms={false}
        confirmLabel="Send message"
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

      <PortalNotificationPreviewModal
        open={leaseSentPreview !== null}
        title="Send lease to resident · preview"
        onClose={() => setLeaseSentPreview(null)}
        recipient={leaseSentPreview?.recipient ?? ""}
        subject={leaseSentPreview?.subject ?? ""}
        body={leaseSentPreview?.body ?? ""}
        footerNote="The lease will be released to the resident portal after you confirm. This message is delivered to PropLane inbox and email."
        confirmLabel="Send lease & notification"
        confirmLabelWithoutMessage="Send lease only"
        confirmBusy={leaseSendBusy}
        confirmBusyLabel="Sending…"
        onConfirm={(skipMessage, channels, draft) => void confirmSendLeaseToResident(skipMessage, channels, draft)}
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
        intro="Choose Email and/or SMS. Always saved to PropLane inbox."
        showSkipMessage={false}
        showChannelPicker
        emailAvailable
        smsAvailable
        confirmLabel="Send reminder"
        confirmBusy={applicationReminderBusyId !== null}
        confirmBusyLabel="Sending…"
        onConfirm={(_skip, channels) => {
          if (!applicationReminderPreview) return;
          void sendApplicationCompletionReminder(applicationReminderPreview.row, channels);
        }}
      />

      <PortalNotificationPreviewModal
        open={messageOpen}
        title={messageScheduleLater ? "Schedule message" : "New message"}
        onClose={() => {
          if (messageBusy) return;
          setMessageOpen(false);
          setMessageScheduleLater(false);
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
