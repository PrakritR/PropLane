"use client";

import { formatLeaseDateLabel } from "@/lib/rental-application/lease-dates";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { LeaseSendSheet } from "@/components/portal/lease-send-sheet";
import { LeaseSignersCard } from "@/components/portal/lease-signers-card";
import { LeaseSharedRoomFacts } from "@/components/portal/lease-shared-room-facts";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { jointRoomCountersignBlocker, jointRoomSiblings } from "@/lib/lease-joint-room";
import { CalendarDays, Home, Wallet } from "lucide-react";
import { createChargesForExecutedLease } from "@/lib/lease-signing-charges.client";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";

import { LeasePrimaryHeaderActions } from "@/components/portal/lease-primary-header-actions";
import {
  RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN,
} from "@/components/portal/portal-data-table";
import { PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { buildLeaseReadyForResidentMessage } from "@/lib/resident-portal-login-copy";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { ManagerLeasesGroupedTable } from "@/components/portal/pro-leases-grouped-table";
import { portalEmptyCopy, portalEmptyNoMatchTitle, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { leaseDetailHref, leaseListHref, type LeaseDetailTabId } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import {
  clusterManagerLeaseListRows,
  leaseRowPlaceLine,
  leaseStageFact,
  leaseUpdatedShort,
  sortManagerLeaseClustersForBucket,
} from "@/lib/manager-lease-list";
import type { ManagerLeaseTab } from "@/data/demo-portal";
import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";
import { ManagerPipelineLeaseEditModal } from "@/components/portal/pro-pipeline-lease-edit-modal";
import { LeaseGenerateModal } from "@/components/portal/lease-generate-modal";
import { LeaseAmendMoveOutModal } from "@/components/portal/lease-amend-move-out-modal";
import { applySignedLeaseRenewal } from "@/lib/lease-renewal-payments";
import { listingAdvertisedRentLabelForLease } from "@/lib/lease-renewal-preview";
import { LeaseSigningModal } from "@/components/portal/lease-signing-modal";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { track } from "@/lib/analytics/track-client";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  appendLeaseThreadMessage,
  deleteLeasePipelineRow,
  leaseAllowsManagerDocumentEdits,
  leasePipelineRowHasDocument,
  managerSignLease,
  confirmUploadedLeaseParseOnServer,
  leaseGenerationSupportedForRow,
  leaseAwaitingManagerCountersign,
  UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE,
  runLeaseDownload,
  runLeaseExport,
  sendLeaseBackToManager,
  hasBothLeaseSignatures,
  leaseRowMatchesListTab,
  leaseGenerationPreviewContextForRow,
  readLeasePipeline,
  resolveManagerLeaseGenerationRow,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,} from "@/lib/lease-pipeline-storage";
import { attachLibraryLeaseDocumentAndParse, retryUploadedLeaseParse, uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
import type { LeaseDocumentLibraryEntry } from "@/lib/lease-document-library";
import { LeaseAttachFromLibraryModal } from "@/components/portal/lease-attach-from-library-modal";
import {
  leaseAllowsSignedPdfUpload,
  leaseAuditTrailFacts,
  leaseCanBeMarkedSignedOffPlatform,
  leaseClaimsExecution,} from "@/lib/lease-execution-evidence";
import { markLeaseSignedOffPlatform } from "@/lib/lease-mark-signed.client";
import { LeaseMarkSignedModal } from "@/components/portal/lease-mark-signed-modal";
import { UploadedLeaseReviewModal } from "@/components/portal/uploaded-lease-review-modal";
import { ImportedLeasePlacementReviewModal } from "@/components/portal/imported-lease-placement-review-modal";
import type { UploadedLeaseFieldKey } from "@/lib/uploaded-lease-extraction";
import { confirmTemplatePlacementReviewForRow } from "@/lib/lease-template-placement-review.client";
import { leaseFirstAnswersBySection} from "@/lib/leasing/lease-first-signing-document";
import { ReviewRow, ReviewSection } from "@/components/portal/pro-application-readonly-review";

function leaseRowAllowsGeneratedBodyEdit(row: LeasePipelineRow): boolean {
  return (
    leaseAllowsManagerDocumentEdits(row) &&
    Boolean(row.generatedHtml) &&
    !row.managerUploadedPdf?.dataUrl &&
    (Boolean(row.templateImportReview) || !row.templateDocumentUrl)
  );
}

/**
 * Upload PDF is the manager's while the document is theirs to change, and also
 * while the lease is out for signature but unsigned — there the upload withdraws
 * the request first (`handleLeaseFileUpload`). Never once a signature exists.
 */
function leaseUploadAllowedForRow(row: LeasePipelineRow): boolean {
  return leaseAllowsSignedPdfUpload(row);
}

/** A draft is sent from the list; one already out for signature is reminded from its record. */
function leaseCanBeSentFromList(row: LeasePipelineRow): boolean {
  return row.status === "Manager Review" || row.status === "Draft";
}

/** One line of plain glyph facts under the signature strip: place, rent, dates. */
function LeaseFactsLine({ row }: { row: LeasePipelineRow }) {
  const start = formatLeaseDateLabel(row.application?.leaseStart);
  const end = formatLeaseDateLabel(row.application?.leaseEnd);
  const term = [start, end].filter(Boolean).join(" – ");
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted" data-attr="lease-facts">
      {row.unit ? (
        <PortalRowFact icon={Home} srLabel="Place">
          {row.unit}
        </PortalRowFact>
      ) : null}
      {row.signedRentLabel ? (
        <PortalRowFact icon={Wallet} srLabel="Rent">
          {row.signedRentLabel}
        </PortalRowFact>
      ) : null}
      {term ? (
        <PortalRowFact icon={CalendarDays} srLabel="Term">
          {term}
        </PortalRowFact>
      ) : null}
    </div>
  );
}

function LeaseFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="min-w-0 truncate text-right text-[13.5px]">{value || "—"}</span>
    </div>
  );
}

export function ManagerLeasesPipelinePanel({
  rows,
  tab,
  refreshKey,
  managerUserId,
  leaseId: leaseIdProp,
  leaseDetailTab: leaseDetailTabProp,
  listBasePath,
  onDetailOpenChange,
  onAddLease,
  emptyCard,
  searchQuery = "",
  onClearSearch,
}: {
  rows: LeasePipelineRow[];
  tab: ManagerLeaseTab;
  refreshKey: number;
  managerUserId?: string | null;
  leaseId?: string;
  /** The lease record's own rail tab (docs/agents/record-page.md); undefined = Overview. */
  leaseDetailTab?: LeaseDetailTabId;
  listBasePath?: string;
  onDetailOpenChange?: (open: boolean) => void;
  onAddLease?: () => void;
  /** The tab's empty card (title, sibling, pill) — the page owns the copy and the tab counts. */
  emptyCard?: ComponentProps<typeof PortalRecordListSurface>["emptyCard"];
  /** The command-bar search box: narrows this bucket's rows; the tab counts stay the bucket totals. */
  searchQuery?: string;
  onClearSearch?: () => void;
}) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTargetRowIdRef = useRef<string | null>(null);
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [generatingRowId] = useState<string | null>(null);
  const [signingRow, setSigningRow] = useState<LeasePipelineRow | null>(null);
  const [signingRowError, setSigningRowError] = useState<string | null>(null);
  const [reminderBusyForRow, setReminderBusyForRow] = useState<string | null>(null);
  /** The one Send lease screen; opened for a lease from the row ⋯, the record header and the Overview. */
  const [sendSheetLeaseId, setSendSheetLeaseId] = useState<string | null>(null);
  const [leaseReminderPreview, setLeaseReminderPreview] = useState<{
    row: LeasePipelineRow;
    recipient: string;
    subject: string;
    body: string;
  } | null>(null);
  const [amendLeaseRow, setAmendLeaseRow] = useState<LeasePipelineRow | null>(null);
  const [editLeaseRowId, setEditLeaseRowId] = useState<string | null>(null);
  const [attachLibraryOpen, setAttachLibraryOpen] = useState(false);
  const [generateLeaseRow, setGenerateLeaseRow] = useState<LeasePipelineRow | null>(null);
  const [generateTemplateId, setGenerateTemplateId] = useState<string | null>(null);
  const [importReviewRowId, setImportReviewRowId] = useState<string | null>(null);
  const [templatePlacementReviewRow, setTemplatePlacementReviewRow] = useState<LeasePipelineRow | null>(null);
  const [markSignedRowId, setMarkSignedRowId] = useState<string | null>(null);
  const { selectedIds, setSelectedIds, toggleSelected } = usePortalRowSelection(tab);

  const handleAmendLeaseSuccess = useCallback(async () => {
    await syncLeasePipelineFromServer(managerUserId, { force: true });
    setAmendLeaseRow(null);
  }, [managerUserId, setAmendLeaseRow]);

  function leaseReminderBody(row: LeasePipelineRow): string {
    const unit = row.unit.trim() || "your unit";
    const leaseStart = row.application?.leaseStart?.trim();
    const leaseEnd = row.application?.leaseEnd?.trim();
    const dateLine = leaseStart
      ? leaseEnd
        ? `Lease dates: ${leaseStart} to ${leaseEnd}`
        : `Lease start date: ${leaseStart}`
      : "";
    return buildLeaseReadyForResidentMessage({
      residentName: row.residentName || "there",
      residentEmail: row.residentEmail.trim(),
      unit,
      variant: "reminder",
      dateLine,
    });
  }

  async function sendLeaseSigningReminder(
    row: LeasePipelineRow,
    recipient: string,
    subject: string,
    text: string,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
  ) {
    setReminderBusyForRow(row.id);
    try {
      const res = await deliverPortalInboxMessage({
        eventCategory: "leases",
        fromName: "Property Manager",
        toEmails: [recipient],
        subject,
        text,
        deliverViaEmail: channels?.viaEmail !== false,
        deliverViaSms: channels?.viaSms === true,
      });

      if (!res.ok) {
        showToast(res.error ?? "Could not send lease signing reminder.");
        return;
      }

      appendLeaseThreadMessage(row.id, "manager", "Sent lease-signing reminder to resident.", managerUserId);
      if (res.skipped) {
        showToast("Reminder saved to PropLane inbox.");
      } else {
        showToast("Lease-signing reminder sent.");
      }
    } catch {
      showToast("Could not send lease signing reminder.");
    } finally {
      setReminderBusyForRow(null);
    }
  }

  function openLeaseSigningReminderPreview(row: LeasePipelineRow) {
    const recipient = row.residentEmail.trim();
    if (!recipient || !recipient.includes("@")) {
      showToast("Resident email is missing or invalid.");
      return;
    }
    setLeaseReminderPreview({
      row,
      recipient,
      subject: `Reminder: sign your lease for ${row.unit}`,
      body: leaseReminderBody(row),
    });
  }

  const hasLeaseDocument = leasePipelineRowHasDocument;
  void refreshKey;
  const bucketRows = useMemo(() => rows.filter((r) => leaseRowMatchesListTab(r, tab) && workspaceContainsProperty(r.propertyId || r.application?.propertyId)), [rows, tab]);

  // The search box narrows the bucket BEFORE clustering, so a resident whose
  // leases no longer match simply has no rows; the tab count is still the bucket.
  const searchedRows = useMemo(
    () =>
      searchQuery.trim()
        ? bucketRows.filter((row) =>
            matchesPortalListSearch(
              searchQuery,
              row.residentName,
              row.residentEmail,
              leaseRowPlaceLine(row),
              leaseStageFact(row),
              leaseUpdatedShort(row),
            ),
          )
        : bucketRows,
    [bucketRows, searchQuery],
  );
  const searchHidesAll = bucketRows.length > 0 && searchedRows.length === 0;

  const leaseClusters = useMemo(
    () => sortManagerLeaseClustersForBucket(clusterManagerLeaseListRows(searchedRows), tab),
    [searchedRows, tab],
  );

  const selectedLeaseRows = useMemo(
    () => searchedRows.filter((row) => selectedIds.has(row.id)),
    [searchedRows, selectedIds],
  );

  const singleSelectedLeaseRow = selectedLeaseRows.length === 1 ? selectedLeaseRows[0]! : null;

  const bulkDeleteRow =
    singleSelectedLeaseRow && singleSelectedLeaseRow.status !== "Fully Signed" ? singleSelectedLeaseRow : null;
  const bulkMarkSignedRow =
    singleSelectedLeaseRow && leaseCanBeMarkedSignedOffPlatform(singleSelectedLeaseRow) ? singleSelectedLeaseRow : null;
  const bulkDeleteButtonClass = `${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`;

  const editLeaseRow = useMemo(
    () => (editLeaseRowId ? (rows.find((row) => row.id === editLeaseRowId) ?? null) : null),
    [editLeaseRowId, rows],
  );

  const detailRow = useMemo(() => {
    if (!leaseIdProp) return null;
    const decoded = decodeURIComponent(leaseIdProp);
    return rows.find((r) => r.id === decoded) ?? null;
  }, [leaseIdProp, rows]);

  const navigateToList = useCallback(() => {
    if (listBasePath) navigate(leaseListHref(listBasePath, tab));
  }, [listBasePath, navigate, tab]);

  const openLeaseDetail = useCallback(
    (row: LeasePipelineRow) => {
      onDetailOpenChange?.(true);
      if (listBasePath) navigate(leaseDetailHref(listBasePath, tab, row.id));
    },
    [listBasePath, navigate, onDetailOpenChange, tab],
  );

  useEffect(() => {
    onDetailOpenChange?.(Boolean(leaseIdProp && detailRow));
  }, [detailRow, leaseIdProp, onDetailOpenChange]);

  const runGenerateLease = (row: LeasePipelineRow, templateId?: string | null) => {
    if (generatingRowId) return;
    setGenerateTemplateId(templateId ?? null);
    setGenerateLeaseRow(resolveManagerLeaseGenerationRow(row.id, managerUserId) ?? row);
  };

  const handleLeaseGenerated = (rowId: string) => {
    setGenerateLeaseRow(null);
    setGenerateTemplateId(null);
    const generatedRow = resolveManagerLeaseGenerationRow(rowId, managerUserId);
    if (generatedRow) openLeaseDetail(generatedRow);
    void syncLeasePipelineFromServer(managerUserId, { force: true });
  };

  const onDownload = (row: LeasePipelineRow) => {
    runLeaseDownload(row, showToast);
  };

  /** C064: Export — a real signed-document-with-audit-page PDF, distinct from plain Download. */
  const onExport = (row: LeasePipelineRow) => {
    runLeaseExport(row, showToast);
  };

  /** Send lease — the one screen (terms, document, schedule, message). Every Send opens it. */
  const openSendLeasePreview = (row: LeasePipelineRow) => {
    setSendSheetLeaseId(row.id);
  };

  const confirmTemplatePlacementReview = async () => {
    const row = templatePlacementReviewRow;
    if (!row) return;
    const result = await confirmTemplatePlacementReviewForRow(row, managerUserId ?? null);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    setTemplatePlacementReviewRow(null);
    if (result.row) openSendLeasePreview(result.row);
  };

  const onSendToResident = (row: LeasePipelineRow) => {
    openSendLeasePreview(row);
  };

  const onDeleteLease = async (row: LeasePipelineRow) => {
    if (!(await confirm({ description: `Delete the lease document for ${row.residentName} (${row.unit})? Generate or upload can recreate it.` }))) return;
    if (deleteLeasePipelineRow(row.id, managerUserId)) {
      showToast("Lease document deleted.");
    } else showToast("Could not delete lease.");
  };

  const onMoveToManagerReview = async (row: LeasePipelineRow) => {
    const result = await sendLeaseBackToManager(row.id, managerUserId);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    appendLeaseThreadMessage(row.id, "manager", "Moved lease back to manager review.", managerUserId);
    showToast("Lease moved to Manager Review.");
    if (!leaseIdProp) navigateToList();
  };

  const onManagerSign = (row: LeasePipelineRow) => {
    if (!leaseAwaitingManagerCountersign(row)) {
      showToast("The resident must sign first before the manager can countersign.");
      return;
    }
    // A joint shared-room lease is countersigned once, after every roommate has signed.
    const waiting = jointRoomCountersignBlocker(row, rows);
    if (waiting) {
      showToast(waiting);
      return;
    }
    setSigningRow(row);
  };

  const handleManagerModalSign = async (signatureName: string, consentVersion: string) => {
    if (!signingRow) return false;
    setSigningRowError(null);
    const result = await managerSignLease(signingRow.id, signatureName.trim(), managerUserId, consentVersion);
    if (result.ok) {
      // One signature covers the whole joint lease: each roommate's own row is countersigned with it.
      const siblingsToSign = jointRoomSiblings(signingRow, readLeasePipeline(managerUserId)).filter(
        (sibling) => leaseAwaitingManagerCountersign(sibling),
      );
      for (const sibling of siblingsToSign) {
        const signedSibling = await managerSignLease(sibling.id, signatureName.trim(), managerUserId, consentVersion);
        if (!signedSibling.ok) {
          setSigningRowError(signedSibling.error);
          return false;
        }
      }
      const fullySigned = hasBothLeaseSignatures({
        ...signingRow,
        managerSignature: { role: "manager", name: signatureName.trim(), signedAtIso: new Date().toISOString() },
      });
      // A renewal's new term/rent applies to the payment schedule only once
      // BOTH parties have signed — the manager countersigns last, so this is
      // the moment the renewed lease becomes the billing source of truth.
      const renewalApplied = fullySigned && signingRow.pendingRenewal
        ? await applySignedLeaseRenewal(signingRow.id, managerUserId ?? null)
        : false;
      // The last signature just landed: the deposit, first month and rent schedule are created now,
      // from the signed terms — nothing waits for Payments to be opened.
      let paymentsScheduled = false;
      if (fullySigned && !signingRow.pendingRenewal) {
        for (const leaseRow of [signingRow, ...siblingsToSign]) {
          const executed = readLeasePipeline(managerUserId).find((r) => r.id === leaseRow.id);
          if (!executed) continue;
          const made = await createChargesForExecutedLease(executed, managerUserId ?? null).catch(() => null);
          if (made && made.ok && made.created) paymentsScheduled = true;
        }
      }
      showToast(
        renewalApplied
          ? "Lease fully signed. Rent and payment schedule updated to the renewed terms."
          : fullySigned
            ? paymentsScheduled
              ? "Lease fully signed. Payments are scheduled."
              : "Lease fully signed."
            : "Manager signature saved.",
      );
      if (!leaseIdProp) navigateToList();
      setSigningRow(null);
      return true;
    } else {
      // Signing waits for the server: the modal stays open and shows why.
      setSigningRowError(result.error);
      return false;
    }
  };

  const handleLeaseFileUpload = useCallback(
    async (rowId: string, file: File) => {
      const target = rows.find((r) => r.id === rowId) ?? null;
      // Out for signature but unsigned: the upload withdraws the request and
      // replaces the document in one step, so a paper-signed copy can be filed
      // without a detour through "Move to review". Any signature makes this
      // path unavailable (`leaseCanBeMarkedSignedOffPlatform`), and
      // `sendLeaseBackToManager` refuses it again server-side.
      if (target && target.status === "Resident Signature Pending" && leaseCanBeMarkedSignedOffPlatform(target)) {
        const proceed = await confirm({
          description: `This withdraws the signing request sent to ${target.residentName} and replaces the lease document. Continue?`,
        });
        if (!proceed) return;
        setPendingRowId(rowId);
        const recalled = await sendLeaseBackToManager(rowId, managerUserId);
        if (!recalled.ok) {
          setPendingRowId(null);
          showToast(recalled.error);
          return;
        }
        appendLeaseThreadMessage(rowId, "manager", "Withdrew the signing request to replace the lease document.", managerUserId);
      }
      setPendingRowId(rowId);
      const res = await uploadAndParseLeasePdf(rowId, file, managerUserId);
      setPendingRowId(null);
      if (!res.ok) {
        showToast(res.error ?? "Upload failed.");
        return;
      }
      if (res.saveError) {
        showToast(`PDF saved, but its PropLane reading was not stored: ${res.saveError}`);
        return;
      }
      if (!res.parse) {
        showToast("PDF saved. Resident sees this on their Lease tab.");
      } else {
        showToast(
          res.parse.status === "parsed"
            ? `Lease imported into PropLane format (${res.parse.sections.length} sections). ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`
            : `Lease PDF saved, but PropLane could not read its text. ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`,
        );
      }
      const uploaded = rows.find((r) => r.id === rowId) ?? target;
      if (uploaded && leaseCanBeMarkedSignedOffPlatform(uploaded)) {
        setMarkSignedRowId(rowId);
      } else if (res.parse) {
        setImportReviewRowId(rowId);
      }
    },
    [confirm, managerUserId, rows, showToast],
  );

  const onPickUpload = async (rowId: string, files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    await handleLeaseFileUpload(rowId, f);
    if (uploadRef.current) uploadRef.current.value = "";
  };

  const handleAttachFromLibrary = useCallback(
    async (rowId: string, entry: LeaseDocumentLibraryEntry) => {
      setPendingRowId(rowId);
      const res = await attachLibraryLeaseDocumentAndParse(rowId, entry, managerUserId);
      setPendingRowId(null);
      if (!res.ok) throw new Error(res.error ?? "Attach failed.");
      if (res.saveError) {
        showToast(`Document attached, but its PropLane reading was not stored: ${res.saveError}`);
      } else if (!res.parse) {
        showToast("Lease document attached from your library.");
      } else {
        showToast(
          res.parse.status === "parsed"
            ? `Lease imported into PropLane format (${res.parse.sections.length} sections). ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`
            : `Lease document attached, but PropLane could not read its text. ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`,
        );
      }
      setAttachLibraryOpen(false);
      const attached = rows.find((r) => r.id === rowId) ?? null;
      if (attached && leaseCanBeMarkedSignedOffPlatform(attached)) {
        setMarkSignedRowId(rowId);
      } else if (res.parse) {
        setImportReviewRowId(rowId);
      }
    },
    [managerUserId, rows, showToast],
  );

  const renderLeaseDetailFooterActions = (row: LeasePipelineRow) => {
    const generation = leaseGenerationSupportedForRow(row);
    return (
      <div
        className="relative w-full min-w-0 flex-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        <LeasePrimaryHeaderActions
          embedded
          flatFooter
          btnClass={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
          row={row}
          downloadDataAttr="lease-download"
          exportDataAttr="lease-export"
          signManagerDataAttr="lease-manager-sign"
          signingReminderDataAttr="lease-signing-reminder"
          deleteDataAttr="lease-delete"
          sendToResidentDataAttr="lease-send-resident"
          moveToManagerReviewDataAttr="lease-move-manager-review"
          editLeaseDataAttr="lease-edit"
          onDownload={() => onDownload(row)}
          onExport={() => onExport(row)}
          onSignManager={() => onManagerSign(row)}
          onSigningReminder={() => openLeaseSigningReminderPreview(row)}
          signingReminderBusy={reminderBusyForRow === row.id}
          onDelete={row.status !== "Fully Signed" ? () => onDeleteLease(row) : undefined}
          onSendToResident={() => onSendToResident(row)}
          shareRecordId={row.id}
          sendToResidentDisabled={false}
          onMoveToManagerReview={() => onMoveToManagerReview(row)}
          canEditDocument={leaseAllowsManagerDocumentEdits(row)}
          generateLeaseDisabled={!generation.ok}
          generateLeaseBusy={generatingRowId === row.id}
          generateLeaseTitle={generation.ok ? undefined : generation.error}
          onGenerateLease={() => runGenerateLease(row)}
          onEditLease={
            leaseRowAllowsGeneratedBodyEdit(row) ? () => setEditLeaseRowId(row.id) : undefined
          }
          onReviewImportedLease={() => setImportReviewRowId(row.id)}
          onUploadPdf={
            leaseUploadAllowedForRow(row)
              // RETURN the promise rather than `void`-ing it: `onUploadPdf` is
              // typed `(file: File) => Promise<void>`, and the header action
              // awaits it to drive its own busy state. Discarding it made the
              // callback `void`, which fails type check and took the whole
              // production build down with it.
              ? (file) => handleLeaseFileUpload(row.id, file)
              : undefined
          }
          uploadPdfBusy={pendingRowId === row.id}
          onMarkSigned={leaseCanBeMarkedSignedOffPlatform(row) ? () => setMarkSignedRowId(row.id) : undefined}
          markSignedDataAttr="lease-mark-signed"
          onNewTerms={() => setAmendLeaseRow(row)}
        />
      </div>
    );
  };

  const renderLeaseRowDetail = (row: LeasePipelineRow) => (
    <LeaseDocumentPreview row={row} flow />
  );

  /**
   * C066: who signed, when, and the document fingerprint — the hash was
   * already computed (`row.documentSha256`, per-signature `documentSha256`)
   * but never rendered to the manager. No dedicated "Audit trail" tab exists
   * (that needs a new id in the shared `record-sections.ts` registry, owned
   * by the shell workstream); this is the real audit content, placed in the
   * lease document tab right under Signatures, and mirrored as its own
   * Overview card below.
   */
  const renderLeaseAuditTrailFacts = (row: LeasePipelineRow) => {
    const facts = leaseAuditTrailFacts(row);
    if (!facts) return null;
    return (
      <div className="px-3 pb-4 sm:px-4" data-attr="lease-audit-trail-facts">
        {facts.map((fact) => (
          <LeaseFact key={fact.label} label={fact.label} value={fact.value} />
        ))}
      </div>
    );
  };

  /**
   * C281 (Ida Cares lease-first): Answers section — one card per
   * license-agreement section, in source order, same shape as the
   * Applications record page's own "Application form" section. Only a
   * lease-first row carries `signingTemplateSnapshot`; an ordinary
   * application-driven lease has nothing to show here.
   */
  const renderLeaseAnswersSection = (row: LeasePipelineRow) => {
    if (!row.signingTemplateSnapshot) return null;
    const sections = leaseFirstAnswersBySection(row.signingTemplateSnapshot, row.signingAnswers);
    if (!sections.length) return null;
    return (
      <div className="grid grid-cols-1 gap-3 px-3 pb-4 sm:px-4 xl:grid-cols-2" data-attr="lease-answers-section">
        {sections.map(({ section, facts }) => (
          <ReviewSection key={section} title={section} data-attr={`lease-answers-section-${section}`}>
            {facts.map((fact) => (
              <ReviewRow key={fact.key} k={fact.label} v={fact.value} />
            ))}
          </ReviewSection>
        ))}
      </div>
    );
  };

  const renderLeaseAmendmentsBody = (row: LeasePipelineRow) => {
    if (row.pendingRenewal) {
      return (
        <div className="px-3 pb-4 sm:px-4" data-attr="lease-amendments-pending">
          <LeaseFact label="New term" value={row.pendingRenewal.leaseTerm} />
          <LeaseFact label="New start" value={row.pendingRenewal.leaseStart} />
          <LeaseFact label="New end" value={row.pendingRenewal.leaseEnd} />
          <LeaseFact
            label="New rent"
            value={row.pendingRenewal.monthlyRent != null ? `$${row.pendingRenewal.monthlyRent}` : ""}
          />
        </div>
      );
    }
    if (row.signedLeaseSnapshots && row.signedLeaseSnapshots.length > 0) {
      return (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card" data-attr="lease-amendments-history">
          {row.signedLeaseSnapshots.map((snapshot) => (
            <li key={snapshot.id} className="px-4 py-3 text-[13.5px]">
              <p className="font-medium text-foreground">{snapshot.label}</p>
              <p className="text-[12px] text-muted">Archived {snapshot.archivedAtIso}</p>
            </li>
          ))}
        </ul>
      );
    }
    return (
      <div className="px-3 pb-4 sm:px-4">
        <PortalListEmptyCard title="No amendments yet" workspaceAware={false} dataAttr="lease-amendments-empty" />
      </div>
    );
  };

  const importReviewRow = useMemo(
    () => (importReviewRowId ? (rows.find((r) => r.id === importReviewRowId) ?? null) : null),
    [importReviewRowId, rows],
  );

  const markSignedRow = useMemo(
    () => (markSignedRowId ? (rows.find((r) => r.id === markSignedRowId) ?? null) : null),
    [markSignedRowId, rows],
  );

  const leaseModals = (
    <>
      <LeaseMarkSignedModal
        key={markSignedRowId ?? "closed"}
        open={markSignedRow !== null}
        row={markSignedRow}
        onClose={() => setMarkSignedRowId(null)}
        onConfirm={async ({ file, signedOn }) => {
          if (!markSignedRow) return "Lease not found.";
          const result = await markLeaseSignedOffPlatform(markSignedRow.id, {
            file,
            signedOn,
            managerUserId: managerUserId ?? null,
          });
          if (!result.ok) return result.error;
          setMarkSignedRowId(null);
          setSelectedIds(new Set());
          showToast(`Lease marked as signed. ${markSignedRow.residentName}'s portal is unlocked.`);
          // "completed" is the Signed tab; "signed" is Manager signature.
          if (listBasePath) navigate(leaseListHref(listBasePath, "completed"));
          return null;
        }}
      />
      {importReviewRow?.uploadedLeaseParse ? (
        <UploadedLeaseReviewModal
          open
          row={importReviewRow}
          parse={importReviewRow.uploadedLeaseParse}
          onClose={() => setImportReviewRowId(null)}
          onConfirm={async ({ overrides, note, useConverted, convertedHtml, convertedHtmlSha256, resolvedSourceIssueCodes, expectedRevision, viewedSourceSha256, viewedConvertedHtmlSha256, viewedRecordFingerprint }) => {
            const result = await confirmUploadedLeaseParseOnServer(importReviewRow.id, {
              managerUserId,
              overrides: overrides as Partial<Record<UploadedLeaseFieldKey, string>>,
              note,
              useConverted,
              convertedHtml,
              convertedHtmlSha256,
              resolvedSourceIssueCodes,
              expectedRevision,
              viewedSourceSha256,
              viewedConvertedHtmlSha256,
              viewedRecordFingerprint,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not confirm the imported lease.");
              return;
            }
            track("lease_import_reviewed", { lease_id: importReviewRow.id, import_kind: "uploaded_pdf", artifact_mode: useConverted ? "converted" : "original_pdf" });
            setImportReviewRowId(null);
            showToast(`Imported lease confirmed. ${useConverted ? "The converted version" : "The original PDF"} can now be sent for signature.`);
          }}
          onRetryRead={async () => {
            const result = await retryUploadedLeaseParse(importReviewRow.id, managerUserId);
            if (!result.ok) {
              showToast(result.error ?? "Could not read that lease PDF.");
              return;
            }
            await syncLeasePipelineFromServer(managerUserId, { force: true });
            showToast(
              result.parse?.status === "parsed"
                ? `Lease imported into PropLane format (${result.parse.sections.length} sections). ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`
                : `PropLane still could not read this PDF. ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`,
            );
          }}
        />
      ) : null}
      {signingRow ? (
        <LeaseSigningModal
          row={signingRow}
          signerName=""
          signerRoleLabel="Manager / authorized agent name"
          onSign={handleManagerModalSign}
          onClose={() => {
            setSigningRow(null);
            setSigningRowError(null);
          }}
          error={signingRowError}
        />
      ) : null}
      <LeaseSendSheet
        open={sendSheetLeaseId !== null}
        leaseId={sendSheetLeaseId}
        managerUserId={managerUserId ?? null}
        onClose={() => setSendSheetLeaseId(null)}
        onSent={() => {
          if (!leaseIdProp) navigateToList();
          void syncLeasePipelineFromServer(managerUserId, { force: true });
        }}
      />
      <ImportedLeasePlacementReviewModal
        row={templatePlacementReviewRow}
        onClose={() => setTemplatePlacementReviewRow(null)}
        onConfirm={confirmTemplatePlacementReview}
      />
      <PortalNotificationPreviewModal
        open={leaseReminderPreview !== null}
        title="Lease signing reminder · preview"
        onClose={() => setLeaseReminderPreview(null)}
        recipient={leaseReminderPreview?.recipient ?? ""}
        subject={leaseReminderPreview?.subject ?? ""}
        body={leaseReminderPreview?.body ?? ""}
        showSkipMessage={false}
        showChannelPicker
        emailAvailable
        smsAvailable
        confirmLabel="Send reminder"
        dynamicSendLabel
        confirmBusy={Boolean(leaseReminderPreview?.row && reminderBusyForRow === leaseReminderPreview.row.id)}
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
            preview.row,
            preview.recipient,
            draft?.subject ?? preview.subject,
            draft?.body ?? preview.body,
            channels,
          );
        }}
      />
      <input
        ref={uploadRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => {
          const id = uploadTargetRowIdRef.current;
          uploadTargetRowIdRef.current = null;
          if (id) void onPickUpload(id, e.target.files);
        }}
      />

      {amendLeaseRow ? (
        <LeaseAmendMoveOutModal
          open
          variant="new-terms"
          onClose={() => setAmendLeaseRow(null)}
          currentEnd={amendLeaseRow.application?.leaseEnd ?? ""}
          leaseStart={amendLeaseRow.application?.leaseStart ?? ""}
          propertyId={amendLeaseRow.propertyId ?? amendLeaseRow.application?.propertyId ?? ""}
          checkUrl="/api/manager/amend-lease"
          amendUrl="/api/manager/amend-lease"
          amendBody={{ leaseId: amendLeaseRow.id }}
          canWaiveEarlyMoveOutFee
          renew={{
            leaseId: amendLeaseRow.id,
            currentTerm: amendLeaseRow.application?.leaseTerm ?? "",
            currentRentLabel: amendLeaseRow.signedRentLabel ?? amendLeaseRow.application?.managerRentOverride ?? "",
            currentRentalType: amendLeaseRow.application?.rentalType,
            renewUrl: "/api/manager/amend-lease",
            listingRentLabel: listingAdvertisedRentLabelForLease(
              amendLeaseRow.propertyId ?? amendLeaseRow.application?.propertyId ?? "",
              amendLeaseRow.roomChoice ?? amendLeaseRow.application?.roomChoice1 ?? "",
            ),
          }}
          onSuccess={() => void handleAmendLeaseSuccess()}
        />
      ) : null}

      {editLeaseRow ? (
        <ManagerPipelineLeaseEditModal
          open
          row={editLeaseRow}
          managerUserId={managerUserId}
          onClose={() => setEditLeaseRowId(null)}
          onDone={() => void syncLeasePipelineFromServer(managerUserId, { force: true })}
          showDownload={hasLeaseDocument(editLeaseRow)}
          onDownload={() => onDownload(editLeaseRow)}
          showUpload={leaseAllowsSignedPdfUpload(editLeaseRow)}
          onUpload={() => {
            uploadTargetRowIdRef.current = editLeaseRow.id;
            uploadRef.current?.click();
          }}
          uploadLabel={
            pendingRowId === editLeaseRow.id
              ? "Uploading…"
              : hasLeaseDocument(editLeaseRow)
                ? "Upload"
                : "Upload PDF"
          }
          uploadDisabled={pendingRowId === editLeaseRow.id}
          showAttachFromLibrary={leaseAllowsSignedPdfUpload(editLeaseRow)}
          onAttachFromLibrary={() => setAttachLibraryOpen(true)}
          showDelete={editLeaseRow.status !== "Fully Signed"}
          onDelete={() => {
            onDeleteLease(editLeaseRow);
            setEditLeaseRowId(null);
          }}
          showShare={hasLeaseDocument(editLeaseRow)}
          showRegenerate={leaseAllowsManagerDocumentEdits(editLeaseRow)}
          regenerateLabel={
            hasLeaseDocument(editLeaseRow) ? "Regenerate" : "Generate lease"
          }
          regenerateDisabled={!leaseGenerationSupportedForRow(editLeaseRow).ok}
          onSendToResident={
            hasLeaseDocument(editLeaseRow) ? () => openSendLeasePreview(editLeaseRow) : undefined
          }
        />
      ) : null}

      {editLeaseRow ? (
        <LeaseAttachFromLibraryModal
          open={attachLibraryOpen}
          onClose={() => setAttachLibraryOpen(false)}
          onAttach={(entry: LeaseDocumentLibraryEntry) => handleAttachFromLibrary(editLeaseRow.id, entry)}
        />
      ) : null}

      <LeaseGenerateModal
        open={generateLeaseRow !== null}
        row={generateLeaseRow}
        managerUserId={managerUserId}
        busy={Boolean(generateLeaseRow && generatingRowId === generateLeaseRow.id)}
        replacesManagerEdits={Boolean(generateLeaseRow?.generatedHtml || generateLeaseRow?.managerUploadedPdf?.dataUrl)}
        initialTemplateId={generateTemplateId}
        onClose={() => {
          if (!generatingRowId) {
            setGenerateLeaseRow(null);
            setGenerateTemplateId(null);
          }
        }}
        onGenerated={handleLeaseGenerated}
      />

    </>
  );

  if (leaseIdProp && detailRow) {
    const detailHeaderActions = renderLeaseDetailFooterActions(detailRow);
    const executed = leaseClaimsExecution(detailRow);
    const sections = recordSections("manager", "lease", {
      basePath: listBasePath ?? "/portal",
      leaseListTab: tab,
    });
    const activeTab = leaseDetailTabProp ?? "overview";
    const backHref = leaseListHref(listBasePath ?? "/portal", tab);
    const ownContent =
      activeTab === "communication" ? (
        renderRecordSection("communication", {
          role: "manager",
          kind: "lease",
          kindLabel: "lease",
          recordId: detailRow.id,
          recordLabel: detailRow.residentName,
          propertyId: detailRow.propertyId,
          contactIds: detailRow.residentEmail ? [detailRow.residentEmail] : undefined,
        })
      ) : (
        // The Lease section: who has signed, one line of terms, then the lease itself. The document
        // pane holds only the lease — nothing the header or the signature strip already says.
        <div className="space-y-4" data-attr="lease-section-lease">
          <LeaseSignersCard
            row={detailRow}
            siblings={jointRoomSiblings(detailRow, rows)}
            onRemind={(leaseId) => {
              const target = rows.find((r) => r.id === leaseId) ?? detailRow;
              openLeaseSigningReminderPreview(target);
            }}
            onSign={() => onManagerSign(detailRow)}
            remindBusyLeaseId={reminderBusyForRow}
          />
          <LeaseFactsLine row={detailRow} />
          {(() => {
            const sharedRoom = leaseGenerationPreviewContextForRow(detailRow, managerUserId)?.sharedRoom;
            return sharedRoom ? (
              <LeaseSharedRoomFacts terms={sharedRoom} addendum={Boolean(detailRow.managerUploadedPdf) && !detailRow.generatedHtml} />
            ) : null;
          })()}
          {renderLeaseRowDetail(detailRow)}
          {executed ? renderLeaseAuditTrailFacts(detailRow) : null}
          {renderLeaseAnswersSection(detailRow)}
          {detailRow.pendingRenewal || (detailRow.signedLeaseSnapshots?.length ?? 0) > 0 ? renderLeaseAmendmentsBody(detailRow) : null}
        </div>
      );
    const onHeaderAction = (actionId: string) => {
      if (actionId === "send") onSendToResident(detailRow);
    };
    return (
      <>
        {leaseModals}
        <PortalRecordDetailPage
          pageTitle="Leases"
          title={detailRow.residentName}
          subtitle={detailRow.unit}
          avatarName={detailRow.residentName}
          backHref={backHref}
          hideBackText
          bareHeader
          iconTitleActions
          dataAttrBack="lease-detail-back"
          pinScrollBody
          scrollBody={false}
        >
          {/* One publisher into the title-row icon slot: Edit lease · Send · Remind / Sign · Download, the rest in the ⋯. */}
          {detailHeaderActions ? <PortalRecordActions>{detailHeaderActions}</PortalRecordActions> : null}
          <div className="flex min-h-0 flex-1 flex-col">
            <PortalPageScrollBody className="min-w-0 max-w-full pt-3 pb-[calc(2.75rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))] lg:pb-3">
              <PortalRecordSectionChrome
                sections={sections}
                recordId={detailRow.id}
                activeId={activeTab}
                title={detailRow.residentName}
                subtitle={detailRow.unit}
                backHref={backHref}
                backLabel="All leases"
                ariaLabel="Lease sections"
                onHeaderAction={onHeaderAction}
              >
                {ownContent}
              </PortalRecordSectionChrome>
            </PortalPageScrollBody>
          </div>
        </PortalRecordDetailPage>
      </>
    );
  }

  return (
    <>
      {leaseModals}
      <PortalRecordListSurface
        isEmpty={searchedRows.length === 0}
        emptyCard={
          searchHidesAll
            ? {
                title: portalEmptyNoMatchTitle("leases", searchQuery),
                section: "leases",
                tone: "muted",
                clear: onClearSearch
                  ? { label: "Clear search", onClick: onClearSearch, dataAttr: "leases-empty-clear-search" }
                  : undefined,
              }
            : (emptyCard ?? {
                title: portalEmptyCopy(`leases.${tab}` as PortalEmptyCopyKey).title,
                section: "leases",
                actions: onAddLease ? [{ label: "Send lease", onClick: onAddLease, dataAttr: "leases-list-add" }] : [],
              })
        }
        onBulkClear={() => setSelectedIds(new Set())}
        bulkCount={selectedIds.size}
        bulkActions={
          // The row ⋯ is five actions — View (the row menu adds it) · Send · Download · Mark as signed · Delete. Everything
          // else (remind, countersign, new terms, export, share, import review…) is on the record.
          singleSelectedLeaseRow ? (
            <>
              {leaseCanBeSentFromList(singleSelectedLeaseRow) ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="leases-bulk-send"
                  onClick={() => openSendLeasePreview(singleSelectedLeaseRow)}
                >
                  Send
                </Button>
              ) : null}
              {hasLeaseDocument(singleSelectedLeaseRow) ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="leases-bulk-download"
                  onClick={() => onDownload(singleSelectedLeaseRow)}
                >
                  Download
                </Button>
              ) : null}
              {bulkMarkSignedRow ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="leases-bulk-mark-signed"
                  onClick={() => setMarkSignedRowId(bulkMarkSignedRow.id)}
                >
                  Mark as signed
                </Button>
              ) : null}
              {bulkDeleteRow ? (
                <Button
                  type="button"
                  variant="outline"
                  className={bulkDeleteButtonClass}
                  data-attr="leases-bulk-delete"
                  onClick={() => onDeleteLease(bulkDeleteRow)}
                >
                  Delete
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        <ManagerLeasesGroupedTable
          clusters={leaseClusters}
          selectedIds={selectedIds}
          onToggleSelected={toggleSelected}
          onOpenLease={openLeaseDetail}
        />
      </PortalRecordListSurface>
    </>
  );
}
