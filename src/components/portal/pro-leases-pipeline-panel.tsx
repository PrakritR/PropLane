"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalBulkMessageCarouselModal } from "@/components/portal/portal-bulk-message-carousel-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalRecordShareLinkButton } from "@/components/portal/portal-record-share-link-button";
import {
  PortalFooterFitActionRow,
  type PortalFooterFitAction,
} from "@/components/portal/portal-footer-fit-action-row";
import {
  RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN,
  ResidentDocumentsDetailFooter,
} from "@/components/portal/portal-data-table";
import { PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { buildLeaseReadyForResidentMessage } from "@/lib/resident-portal-login-copy";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { ManagerLeasesGroupedTable } from "@/components/portal/pro-leases-grouped-table";
import { PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import { leaseDetailHref, leaseListHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  clusterManagerLeaseListRows,
  sortManagerLeaseClustersForBucket,
} from "@/lib/manager-lease-list";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { ManagerLeaseTab } from "@/data/demo-portal";
import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";
import { ManagerPipelineLeaseEditModal } from "@/components/portal/pro-pipeline-lease-edit-modal";
import { LeaseGenerateModal } from "@/components/portal/lease-generate-modal";
import { LeaseAmendMoveOutModal } from "@/components/portal/lease-amend-move-out-modal";
import { applySignedLeaseRenewal } from "@/lib/lease-renewal-payments";
import { LeaseSigningModal } from "@/components/portal/lease-signing-modal";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  appendLeaseThreadMessage,
  deleteLeasePipelineRow,
  generateLeaseHtmlForRow,
  leaseAllowsManagerDocumentEdits,
  managerSignLease,
  confirmUploadedLeaseParse,
  leaseNeedsUploadedLeaseReviewAction,
  leaseLandlordNameWarning,
  leaseSendGateBlocker,
  leaseSendGateBlockerAmong,
  leaseGenerationSupportedForRow,
  UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE,
  runLeaseDownload,
  sendLeaseBackToManager,
  sendLeaseToResident,
  hasBothLeaseSignatures,
  leaseRowMatchesManagerTab,
  residentHasSignedLease,
  resolveManagerLeaseGenerationRow,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { retryUploadedLeaseParse, uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
import { UploadedLeaseReviewModal } from "@/components/portal/uploaded-lease-review-modal";
import type { UploadedLeaseFieldKey } from "@/lib/uploaded-lease-extraction";

function leaseRowAllowsGeneratedBodyEdit(row: LeasePipelineRow): boolean {
  return (
    leaseAllowsManagerDocumentEdits(row) &&
    Boolean(row.generatedHtml) &&
    !row.managerUploadedPdf?.dataUrl &&
    !row.templateDocumentUrl
  );
}

function leaseRowIsBulkSendable(
  row: LeasePipelineRow,
  // `leaseSendGateBlocker` reports "not blocked" as null; this only tests the
  // result for truthiness, so both spellings of absent are accepted.
  sendBlockedReason: (row: LeasePipelineRow) => string | null | undefined,
): boolean {
  const hasDocument = Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);
  return (
    (row.status === "Manager Review" || row.status === "Draft") &&
    hasDocument &&
    !sendBlockedReason(row)
  );
}

export function ManagerLeasesPipelinePanel({
  rows,
  tab,
  refreshKey,
  managerUserId,
  residentAccountEmails,
  leaseId: leaseIdProp,
  listBasePath,
  onDetailOpenChange,
  onAddLease,
}: {
  rows: LeasePipelineRow[];
  tab: ManagerLeaseTab;
  refreshKey: number;
  managerUserId?: string | null;
  residentAccountEmails: Set<string>;
  leaseId?: string;
  listBasePath?: string;
  onDetailOpenChange?: (open: boolean) => void;
  onAddLease?: () => void;
}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTargetRowIdRef = useRef<string | null>(null);
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [generatingRowId, setGeneratingRowId] = useState<string | null>(null);
  const [signingRow, setSigningRow] = useState<LeasePipelineRow | null>(null);
  const [reminderBusyForRow, setReminderBusyForRow] = useState<string | null>(null);
  const [sendingToResidentRowId, setSendingToResidentRowId] = useState<string | null>(null);
  const [leaseSentPreview, setLeaseSentPreview] = useState<{
    row: LeasePipelineRow;
    recipient: string;
    subject: string;
    body: string;
  } | null>(null);
  const [leaseReminderPreview, setLeaseReminderPreview] = useState<{
    row: LeasePipelineRow;
    recipient: string;
    subject: string;
    body: string;
  } | null>(null);
  const [amendLeaseRow, setAmendLeaseRow] = useState<LeasePipelineRow | null>(null);
  const [editLeaseRowId, setEditLeaseRowId] = useState<string | null>(null);
  const [generateLeaseRow, setGenerateLeaseRow] = useState<LeasePipelineRow | null>(null);
  const [generateTemplateId, setGenerateTemplateId] = useState<string | null>(null);
  const [importReviewRowId, setImportReviewRowId] = useState<string | null>(null);
  const [bulkLeaseSendRows, setBulkLeaseSendRows] = useState<LeasePipelineRow[] | null>(null);
  const { selectedIds, setSelectedIds, toggleSelected } = usePortalRowSelection(tab);

  const handleAmendLeaseSuccess = useCallback(async () => {
    await syncLeasePipelineFromServer(managerUserId, { force: true });
    setAmendLeaseRow(null);
  }, [managerUserId]);

  function leaseSentToResidentBody(row: LeasePipelineRow): string {
    const unit = row.unit.trim() || "your unit";
    return buildLeaseReadyForResidentMessage({
      residentName: row.residentName || "there",
      residentEmail: row.residentEmail.trim(),
      unit,
      variant: "send",
    });
  }

  async function notifyResidentLeaseReady(
    row: LeasePipelineRow,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject: string; text: string },
  ): Promise<{ ok: boolean; skipped?: boolean }> {
    const unit = row.unit.trim() || "your unit";
    const result = await deliverPortalInboxMessage({
      eventCategory: "leases",
      fromName: "Property Manager",
      toEmails: [row.residentEmail.trim()],
      subject: draft?.subject ?? `Your lease for ${unit} is ready to sign`,
      text: draft?.text ?? leaseSentToResidentBody(row),
      deliverViaEmail: channels?.viaEmail !== false,
      deliverViaSms: channels?.viaSms === true,
    });
    return { ok: result.ok, skipped: result.skipped };
  }

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

  // `leaseSendGateBlocker` re-normalizes the whole applications store on every
  // call, so the RENDER path reads it at most once per pass and shares the
  // snapshot across rows. Rebuilt each render, so it is never stale; event
  // handlers still call `leaseSendGateBlocker` for a read fresh at click time.
  let renderPassApplicationRows: DemoApplicantRow[] | null = null;
  const sendGateBlockerForRender = (row: LeasePipelineRow) =>
    leaseSendGateBlockerAmong(row, (renderPassApplicationRows ??= readManagerApplicationRows()));

  const hasLeaseDocument = (row: LeasePipelineRow) => Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);
  void refreshKey;
  const bucketRows = useMemo(() => rows.filter((r) => leaseRowMatchesManagerTab(r, tab)), [rows, tab]);

  const leaseClusters = useMemo(
    () => sortManagerLeaseClustersForBucket(clusterManagerLeaseListRows(bucketRows), tab),
    [bucketRows, tab],
  );

  const selectedLeaseRows = useMemo(
    () => bucketRows.filter((row) => selectedIds.has(row.id)),
    [bucketRows, selectedIds],
  );

  const leaseRowSendBlockedReason = useCallback(
    (row: LeasePipelineRow) => {
      const residentEmail = row.residentEmail.trim().toLowerCase();
      if (!residentEmail || !residentAccountEmails.has(residentEmail)) {
        return "Resident must create their PropLane resident account before you can send the lease.";
      }
      if (!row.generatedHtml && !row.managerUploadedPdf?.dataUrl) {
        return "Generate or upload a lease document first.";
      }
      return leaseSendGateBlocker(row);
    },
    [residentAccountEmails],
  );

  const bulkSendableLeaseRows = useMemo(
    () => selectedLeaseRows.filter((row) => leaseRowIsBulkSendable(row, leaseRowSendBlockedReason)),
    [leaseRowSendBlockedReason, selectedLeaseRows],
  );

  const singleSelectedLeaseRow = selectedLeaseRows.length === 1 ? selectedLeaseRows[0]! : null;

  const showBulkSendButton =
    tab === "manager" &&
    selectedLeaseRows.length > 0 &&
    (selectedLeaseRows.length > 1
      ? bulkSendableLeaseRows.length > 0
      : Boolean(singleSelectedLeaseRow && hasLeaseDocument(singleSelectedLeaseRow)));

  const showBulkGenerateButton =
    tab === "manager" &&
    Boolean(
      singleSelectedLeaseRow &&
        selectedLeaseRows.length === 1 &&
        !hasLeaseDocument(singleSelectedLeaseRow) &&
        leaseAllowsManagerDocumentEdits(singleSelectedLeaseRow),
    );

  const openBulkSendLeasePreview = useCallback(() => {
    if (bulkSendableLeaseRows.length === 0) {
      showToast("None of the selected leases can be sent. Each needs a document, resident account, and no review blockers.");
      return;
    }
    if (bulkSendableLeaseRows.length < selectedLeaseRows.length) {
      showToast(
        `Sending ${bulkSendableLeaseRows.length} of ${selectedLeaseRows.length} selected — others need a document, resident account, or review first.`,
      );
    }
    setBulkLeaseSendRows(bulkSendableLeaseRows);
  }, [bulkSendableLeaseRows, selectedLeaseRows.length, showToast]);


  const editLeaseRow = useMemo(
    () => (editLeaseRowId ? (rows.find((row) => row.id === editLeaseRowId) ?? null) : null),
    [editLeaseRowId, rows],
  );

  const confirmBulkSendLeases = useCallback(
    async (
      scope: "all" | "single",
      skipMessage: boolean,
      drafts: Record<string, { subject: string; body: string }>,
      singleId?: string,
    ) => {
      if (!bulkLeaseSendRows || sendingToResidentRowId) return;
      const targets =
        scope === "single" && singleId
          ? bulkLeaseSendRows.filter((row) => row.id === singleId)
          : bulkLeaseSendRows.filter((row) => row.id in drafts);
      if (targets.length === 0) return;

      for (const row of targets) {
        setSendingToResidentRowId(row.id);
        try {
          const result = await sendLeaseToResident(row.id, managerUserId);
          if (!result.ok) {
            showToast(result.error ?? "Could not send lease.");
            return;
          }
          appendLeaseThreadMessage(
            row.id,
            "manager",
            "Sent lease to resident for review and signature.",
            managerUserId,
          );
          if (!skipMessage) {
            const unit = row.unit.trim() || "your unit";
            const draft = drafts[row.id];
            await notifyResidentLeaseReady(row, undefined, {
              subject: draft?.subject ?? `Your lease for ${unit} is ready to sign`,
              text: draft?.body ?? leaseSentToResidentBody(row),
            });
          }
        } finally {
          setSendingToResidentRowId(null);
        }
      }

      setBulkLeaseSendRows(null);
      if (scope === "all") {
        setSelectedIds(new Set());
      } else if (singleId) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(singleId);
          return next;
        });
      }
      showToast(
        skipMessage
          ? targets.length === 1
            ? "Lease sent to resident portal (no notification sent)."
            : `${targets.length} leases sent (no notifications).`
          : targets.length === 1
            ? "Lease sent to resident portal with notification."
            : `${targets.length} leases sent to residents.`,
      );
    },
    [bulkLeaseSendRows, managerUserId, sendingToResidentRowId, setSelectedIds, showToast],
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

  const handleLeaseGenerated = (_rowId: string) => {
    setGenerateLeaseRow(null);
    setGenerateTemplateId(null);
    void syncLeasePipelineFromServer(managerUserId, { force: true });
  };

  const onDownload = (row: LeasePipelineRow) => {
    runLeaseDownload(row, showToast);
  };

  const openSendLeasePreview = (row: LeasePipelineRow) => {
    const residentEmail = row.residentEmail.trim().toLowerCase();
    if (!residentEmail || !residentAccountEmails.has(residentEmail)) {
      showToast("Resident must create their PropLane resident account before you can send the lease.");
      return;
    }
    if (!row.generatedHtml && !row.managerUploadedPdf?.dataUrl) {
      showToast("Generate or upload a lease document first.");
      return;
    }
    // The same refusals `sendLeaseToResident` makes, checked BEFORE the preview
    // opens. Reaching "Send lease & notification" and only then being refused
    // reads as a broken send; being told why up front is the affordance.
    const gateBlocker = leaseSendGateBlocker(row);
    if (gateBlocker) {
      showToast(gateBlocker);
      // Open the review only for the blockers it can actually clear — an unread
      // import or an unacknowledged mismatch, which is exactly what the "Review
      // import" CTA is scoped to. An unapproved applicant is fixed in
      // Applications, so dropping that manager into a Confirm flow that still
      // ends in the same refusal is a dead end; the toast alone is the answer.
      if (leaseNeedsUploadedLeaseReviewAction(row)) setImportReviewRowId(row.id);
      return;
    }
    const unit = row.unit.trim() || "your unit";
    setLeaseSentPreview({
      row,
      recipient: row.residentEmail.trim(),
      subject: `Your lease for ${unit} is ready to sign`,
      body: leaseSentToResidentBody(row),
    });
  };

  // Declared AFTER `openSendLeasePreview`, which it calls. Relying on hoisting
  // here stopped the compiler tracking the dependency.
  const openBulkOrSingleSend = useCallback(() => {
    if (singleSelectedLeaseRow && selectedLeaseRows.length === 1) {
      openSendLeasePreview(singleSelectedLeaseRow);
      return;
    }
    openBulkSendLeasePreview();
  }, [openBulkSendLeasePreview, selectedLeaseRows.length, singleSelectedLeaseRow]);

  const confirmSendLeaseToResident = async (
    skipMessage: boolean,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject: string; body: string },
  ) => {
    if (!leaseSentPreview || sendingToResidentRowId) return;
    const { row } = leaseSentPreview;
    setSendingToResidentRowId(row.id);
    try {
      const result = await sendLeaseToResident(row.id, managerUserId);
      if (!result.ok) {
        showToast(result.error ?? "Could not send lease.");
        return;
      }
      setLeaseSentPreview(null);
      appendLeaseThreadMessage(row.id, "manager", "Sent lease to resident for review and signature.", managerUserId);
      if (skipMessage) {
        showToast("Lease sent to resident portal (no notification sent).");
      } else {
        const notice = await notifyResidentLeaseReady(row, channels, {
          subject: draft?.subject ?? leaseSentPreview.subject,
          text: draft?.body ?? leaseSentPreview.body,
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
    } finally {
      setSendingToResidentRowId(null);
    }
  };

  const onSendToResident = (row: LeasePipelineRow) => {
    openSendLeasePreview(row);
  };

  const onDeleteLease = (row: LeasePipelineRow) => {
    if (!window.confirm(`Delete the lease document for ${row.residentName} (${row.unit})? Generate or upload can recreate it.`)) return;
    if (deleteLeasePipelineRow(row.id, managerUserId)) {
      showToast("Lease document deleted.");
    } else showToast("Could not delete lease.");
  };

  const onMoveToManagerReview = (row: LeasePipelineRow) => {
    const result = sendLeaseBackToManager(row.id, managerUserId);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    appendLeaseThreadMessage(row.id, "manager", "Moved lease back to manager review.", managerUserId);
    showToast("Lease moved to Manager Review.");
    if (!leaseIdProp) navigateToList();
  };

  const onManagerSign = (row: LeasePipelineRow) => {
    if (!residentHasSignedLease(row)) {
      showToast("The resident must sign first before the manager can countersign.");
      return;
    }
    setSigningRow(row);
  };

  const handleManagerModalSign = async (signatureName: string, consentVersion: string) => {
    if (!signingRow) return false;
    const ok = await managerSignLease(signingRow.id, signatureName.trim(), managerUserId, consentVersion);
    if (ok) {
      const fullySigned = hasBothLeaseSignatures({
        ...signingRow,
        managerSignature: { role: "manager", name: signatureName.trim(), signedAtIso: new Date().toISOString() },
      });
      // A renewal's new term/rent applies to the payment schedule only once
      // BOTH parties have signed — the manager countersigns last, so this is
      // the moment the renewed lease becomes the billing source of truth.
      const renewalApplied = fullySigned && signingRow.pendingRenewal
        ? applySignedLeaseRenewal(signingRow.id, managerUserId ?? null)
        : false;
      showToast(
        renewalApplied
          ? "Lease fully signed. Rent and payment schedule updated to the renewed terms."
          : fullySigned
            ? "Lease fully signed."
            : "Manager signature saved.",
      );
      if (!leaseIdProp) navigateToList();
      setSigningRow(null);
      return true;
    } else {
      showToast("Could not sign lease.");
      return false;
    }
  };

  const onPickUpload = async (rowId: string, files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setPendingRowId(rowId);
    const res = await uploadAndParseLeasePdf(rowId, f, managerUserId);
    setPendingRowId(null);
    if (uploadRef.current) uploadRef.current.value = "";
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
      return;
    }
    setImportReviewRowId(rowId);
    showToast(
      res.parse.status === "parsed"
        ? `Lease imported into PropLane format (${res.parse.sections.length} sections). ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`
        : `Lease PDF saved, but PropLane could not read its text. ${UPLOADED_LEASE_REVIEW_REQUIRED_MESSAGE}`,
    );
  };

  const renderLeaseDetailFooterActions = (row: LeasePipelineRow) => {
    const canEditDocument = leaseAllowsManagerDocumentEdits(row);
    const canEditGeneratedBody = leaseRowAllowsGeneratedBodyEdit(row);
    const showGenerate = canEditDocument;
    const hasDocument = hasLeaseDocument(row);
    const sendBlockedReason = !residentAccountEmails.has(row.residentEmail.trim().toLowerCase())
      ? "Resident must create their PropLane resident account before you can send the lease."
      : !row.generatedHtml && !row.managerUploadedPdf?.dataUrl
        ? "Generate or upload a lease document first."
        : sendGateBlockerForRender(row);
    const showSendToResident =
      hasDocument && (row.status === "Manager Review" || row.status === "Draft");
    const showMoveToReview = row.status === "Resident Signature Pending";
    const showManagerSign = !row.managerSignature && residentHasSignedLease(row);
    const showSigningReminder = row.status === "Resident Signature Pending";
    const showRenewals = hasBothLeaseSignatures(row) && row.status === "Fully Signed";
    const showReviewImport = Boolean(row.uploadedLeaseParse);
    const importNeedsReview = leaseNeedsUploadedLeaseReviewAction(row);
    const reviewImportLabel = importNeedsReview ? "Review import" : "Imported lease";
    const actionBtnClass = RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN;

    const showEditButton =
      canEditDocument || hasDocument || showGenerate || canEditGeneratedBody || showReviewImport;

    const actions: PortalFooterFitAction[] = [];

    if (showSendToResident) {
      actions.push({
        id: "send",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-send-resident"
            disabled={sendingToResidentRowId === row.id}
            title={sendBlockedReason ?? undefined}
            onClick={() => openSendLeasePreview(row)}
          >
            {sendingToResidentRowId === row.id ? "Sending…" : "Send"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="lease-send-resident"
            disabled={sendingToResidentRowId === row.id}
            onSelect={() => openSendLeasePreview(row)}
          >
            {sendingToResidentRowId === row.id ? "Sending…" : "Send"}
          </DropdownMenuItem>
        ),
      });
    }

    if (hasDocument) {
      actions.push({
        id: "share",
        button: (
          <PortalRecordShareLinkButton
            kind="lease"
            recordId={row.id}
            className={actionBtnClass}
            dataAttr="lease-share"
            recordTitle={row.residentName?.trim() || row.unit?.trim() || row.propertyId}
          />
        ),
        menuItem: (
          <PortalRecordShareLinkButton
            kind="lease"
            recordId={row.id}
            menuItem
            dataAttr="lease-share-menu"
            recordTitle={row.residentName?.trim() || row.unit?.trim() || row.propertyId}
          />
        ),
      });
    }

    if (showEditButton) {
      actions.push({
        id: "edit",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-edit"
            onClick={() => setEditLeaseRowId(row.id)}
          >
            Edit
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="lease-edit" onSelect={() => setEditLeaseRowId(row.id)}>
            Edit
          </DropdownMenuItem>
        ),
      });
    }

    if (showGenerate && !hasDocument) {
      const generationOk = leaseGenerationSupportedForRow(row).ok;
      actions.push({
        id: "generate",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-generate"
            disabled={!generationOk || generatingRowId === row.id}
            onClick={() => runGenerateLease(row)}
          >
            {generatingRowId === row.id ? "Generating…" : "Generate lease"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="lease-generate"
            disabled={!generationOk || generatingRowId === row.id}
            onSelect={() => runGenerateLease(row)}
          >
            {generatingRowId === row.id ? "Generating…" : "Generate lease"}
          </DropdownMenuItem>
        ),
      });
    }

    if (showReviewImport) {
      actions.push({
        id: "review-import",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-review-import"
            onClick={() => setImportReviewRowId(row.id)}
          >
            {reviewImportLabel}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="lease-review-import" onSelect={() => setImportReviewRowId(row.id)}>
            {reviewImportLabel}
          </DropdownMenuItem>
        ),
      });
    }

    if (showManagerSign) {
      actions.push({
        id: "sign",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-manager-sign"
            onClick={() => onManagerSign(row)}
          >
            Sign
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="lease-manager-sign" onSelect={() => onManagerSign(row)}>
            Sign
          </DropdownMenuItem>
        ),
      });
    } else if (showSigningReminder) {
      actions.push({
        id: "reminder",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-signing-reminder"
            disabled={reminderBusyForRow === row.id}
            title="Send signing reminder"
            onClick={() => openLeaseSigningReminderPreview(row)}
          >
            {reminderBusyForRow === row.id ? "Sending…" : "Send reminder"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="lease-signing-reminder"
            disabled={reminderBusyForRow === row.id}
            onSelect={() => openLeaseSigningReminderPreview(row)}
          >
            {reminderBusyForRow === row.id ? "Sending…" : "Send reminder"}
          </DropdownMenuItem>
        ),
      });
    }

    if (showMoveToReview) {
      actions.push({
        id: "move-review",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-move-manager-review"
            onClick={() => onMoveToManagerReview(row)}
          >
            Move to review
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="lease-move-manager-review" onSelect={() => onMoveToManagerReview(row)}>
            Move to review
          </DropdownMenuItem>
        ),
      });
    }

    if (showRenewals) {
      actions.push({
        id: "renew",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="lease-renew"
            onClick={() => setAmendLeaseRow(row)}
          >
            Renew lease
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="lease-renew"
            onSelect={() => setAmendLeaseRow(row)}
          >
            Renew lease
          </DropdownMenuItem>
        ),
      });
      actions.push({
        id: "extend",
        button: (
          <Button type="button" variant="outline" className={actionBtnClass} onClick={() => setAmendLeaseRow(row)}>
            Extend move-out
          </Button>
        ),
        menuItem: <DropdownMenuItem onSelect={() => setAmendLeaseRow(row)}>Extend move-out</DropdownMenuItem>,
      });
    }

    if (actions.length === 0) return null;

    return (
      <div
        className="relative w-full min-w-0 flex-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <PortalFooterFitActionRow actions={actions} moreLabel="More lease actions" />
      </div>
    );
  };

  const renderLeaseRowDetail = (row: LeasePipelineRow) => (
    <LeaseDocumentPreview row={row} flow />
  );

  const importReviewRow = useMemo(
    () => (importReviewRowId ? (rows.find((r) => r.id === importReviewRowId) ?? null) : null),
    [importReviewRowId, rows],
  );

  const leaseModals = (
    <>
      {importReviewRow?.uploadedLeaseParse ? (
        <UploadedLeaseReviewModal
          open
          row={importReviewRow}
          parse={importReviewRow.uploadedLeaseParse}
          onClose={() => setImportReviewRowId(null)}
          onConfirm={({ overrides, note }) => {
            const result = confirmUploadedLeaseParse(importReviewRow.id, {
              managerUserId,
              overrides: overrides as Partial<Record<UploadedLeaseFieldKey, string>>,
              note,
            });
            if (!result.ok) {
              showToast(result.error ?? "Could not confirm the imported lease.");
              return;
            }
            setImportReviewRowId(null);
            void syncLeasePipelineFromServer(managerUserId, { force: true });
            showToast("Imported lease confirmed. It can now be sent for signature.");
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
          onClose={() => setSigningRow(null)}
        />
      ) : null}
      <PortalNotificationPreviewModal
        open={leaseSentPreview !== null}
        title="Send lease to resident · preview"
        onClose={() => setLeaseSentPreview(null)}
        recipient={leaseSentPreview?.recipient ?? ""}
        subject={leaseSentPreview?.subject ?? ""}
        body={leaseSentPreview?.body ?? ""}
        warning={
          leaseSentPreview ? leaseLandlordNameWarning(leaseSentPreview.row) ?? undefined : undefined
        }
        warningLead={null}
        footerNote="The lease will be released to the resident portal after you confirm. This message is delivered to PropLane inbox and email."
        confirmLabel="Send lease & notification"
        confirmLabelWithoutMessage="Send lease only"
        confirmBusy={Boolean(leaseSentPreview && sendingToResidentRowId === leaseSentPreview.row.id)}
        confirmBusyLabel="Sending…"
        onConfirm={(skipMessage, channels, draft) => void confirmSendLeaseToResident(skipMessage, channels, draft)}
        deliverViaKind="leases"
        smsAvailable
      />
      {bulkLeaseSendRows && bulkLeaseSendRows.length > 0 ? (
        <PortalBulkMessageCarouselModal
          open
          title={
            bulkLeaseSendRows.length > 1
              ? `Send leases to residents (${bulkLeaseSendRows.length})`
              : "Send lease to resident · preview"
          }
          intro="The lease will be released to each resident portal after you confirm. Messages go to PropLane inbox and email."
          items={bulkLeaseSendRows.map((row) => {
            const unit = row.unit.trim() || "your unit";
            return {
              id: row.id,
              label: `${row.residentName} · ${row.unit}`,
              recipient: row.residentEmail.trim(),
              subject: `Your lease for ${unit} is ready to sign`,
              body: leaseSentToResidentBody(row),
              emailAvailable: Boolean(row.residentEmail.includes("@")),
            };
          })}
          confirmLabel="Send lease & notification"
          confirmLabelSingle="Send this lease"
          confirmLabelWithoutMessage="Send lease only"
          skipMessageLabel="Don't send notification"
          confirmBusy={Boolean(sendingToResidentRowId)}
          confirmBusyLabel="Sending…"
          onClose={() => {
            if (sendingToResidentRowId) return;
            setBulkLeaseSendRows(null);
          }}
          onConfirm={(scope, { skipMessage, drafts, singleId }) =>
            void confirmBulkSendLeases(scope, skipMessage, drafts, singleId)
          }
        />
      ) : null}
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
          onClose={() => setAmendLeaseRow(null)}
          currentEnd={amendLeaseRow.application?.leaseEnd ?? ""}
          leaseStart={amendLeaseRow.application?.leaseStart ?? ""}
          propertyId={amendLeaseRow.propertyId ?? amendLeaseRow.application?.propertyId ?? ""}
          checkUrl="/api/manager/amend-lease"
          amendUrl="/api/manager/amend-lease"
          amendBody={{ leaseId: amendLeaseRow.id }}
          renew={{
            leaseId: amendLeaseRow.id,
            currentTerm: amendLeaseRow.application?.leaseTerm ?? "",
            currentRentLabel: amendLeaseRow.signedRentLabel ?? amendLeaseRow.application?.managerRentOverride ?? "",
            currentRentalType: amendLeaseRow.application?.rentalType,
            renewUrl: "/api/manager/amend-lease",
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
          showUpload={leaseAllowsManagerDocumentEdits(editLeaseRow)}
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
          sendToResidentBusy={sendingToResidentRowId === editLeaseRow.id}
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
    const detailFooterActions = renderLeaseDetailFooterActions(detailRow);
    return (
      <>
        {leaseModals}
        <PortalRecordDetailPage
          pageTitle="Leases"
          title={detailRow.residentName}
          subtitle={detailRow.unit}
          avatarName={detailRow.residentName}
          backHref={listBasePath ? leaseListHref(listBasePath, tab) : undefined}
          hideBackText
          bareHeader
          dataAttrBack="lease-detail-back"
          pinScrollBody
          scrollBody={false}
          footerOmitSpacer
          footer={
            detailFooterActions ? (
              <ResidentDocumentsDetailFooter>{detailFooterActions}</ResidentDocumentsDetailFooter>
            ) : undefined
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <PortalPageScrollBody className="min-w-0 max-w-full pt-3 pb-[calc(2.75rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))] lg:pb-3">
              {renderLeaseRowDetail(detailRow)}
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
        isEmpty={bucketRows.length === 0}
        add={
          onAddLease
            ? {
                label: "Add lease",
                ariaLabel: "Add lease",
                icon: PORTAL_LIST_ADD_ICONS.lease,
                onClick: onAddLease,
                dataAttr: "leases-list-add",
              }
            : undefined
        }
        bulkCount={selectedIds.size}
        bulkActions={
          selectedLeaseRows.length > 0 ? (
            <>
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="leases-bulk-edit"
                disabled={!singleSelectedLeaseRow}
                onClick={() => {
                  if (!singleSelectedLeaseRow) return;
                  setEditLeaseRowId(singleSelectedLeaseRow.id);
                }}
              >
                Edit
              </Button>
              {showBulkSendButton ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="leases-bulk-send"
                  disabled={Boolean(sendingToResidentRowId)}
                  onClick={openBulkOrSingleSend}
                >
                  {sendingToResidentRowId ? "Sending…" : "Send"}
                </Button>
              ) : null}
              {showBulkGenerateButton && singleSelectedLeaseRow ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="leases-bulk-generate"
                  disabled={
                    !leaseGenerationSupportedForRow(singleSelectedLeaseRow).ok ||
                    generatingRowId === singleSelectedLeaseRow.id
                  }
                  onClick={() => runGenerateLease(singleSelectedLeaseRow)}
                >
                  {generatingRowId === singleSelectedLeaseRow.id ? "Generating…" : "Generate lease"}
                </Button>
              ) : null}
              {singleSelectedLeaseRow && hasLeaseDocument(singleSelectedLeaseRow) ? (
                <PortalRecordShareLinkButton
                  kind="lease"
                  recordId={singleSelectedLeaseRow.id}
                  className={PORTAL_BULK_BAR_BTN}
                  dataAttr="leases-bulk-share"
                  recordTitle={
                    singleSelectedLeaseRow.residentName?.trim() ||
                    singleSelectedLeaseRow.unit?.trim() ||
                    singleSelectedLeaseRow.propertyId
                  }
                />
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
