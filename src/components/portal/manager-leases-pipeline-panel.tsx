"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  RESIDENT_DETAIL_HEADER_ACTION_BTN,
  RESIDENT_DETAIL_HEADER_ACTIONS_ROW,
} from "@/components/portal/portal-metrics";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { buildLeaseReadyForResidentMessage } from "@/lib/resident-portal-login-copy";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalListAddRow, PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import { INBOX_LIST_SCROLL } from "@/components/portal/portal-inbox-ui";
import { leaseDetailHref, leaseListHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ManagerLeaseTab } from "@/data/demo-portal";
import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";
import { ManagerPipelineLeaseEditModal } from "@/components/portal/manager-pipeline-lease-edit-modal";
import { LeaseGenerateModal } from "@/components/portal/lease-generate-modal";
import { LeaseAmendMoveOutModal, LeaseRenewModal } from "@/components/portal/lease-amend-move-out-modal";
import { applySignedLeaseRenewal } from "@/lib/lease-renewal-payments";
import { LeaseSigningModal } from "@/components/portal/lease-signing-modal";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import {
  appendLeaseThreadMessage,
  deleteLeasePipelineRow,
  generateLeaseHtmlForRow,
  leaseAllowsManagerDocumentEdits,
  managerSignLease,
  confirmUploadedLeaseParse,
  leaseNeedsUploadedLeaseReviewAction,
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

export function ManagerLeasesPipelinePanel({
  rows,
  tab,
  refreshKey,
  managerUserId,
  residentAccountEmails,
  onEmailAccountSetup,
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
  onEmailAccountSetup?: (email: string, name: string, axisId?: string) => void;
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
  const [emailBusyForRow, setEmailBusyForRow] = useState<string | null>(null);
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
  const [renewLeaseRow, setRenewLeaseRow] = useState<LeasePipelineRow | null>(null);
  const [renewInitialTerm, setRenewInitialTerm] = useState<string | undefined>(undefined);
  const [editLeaseRowId, setEditLeaseRowId] = useState<string | null>(null);
  const [generateLeaseRow, setGenerateLeaseRow] = useState<LeasePipelineRow | null>(null);
  const [importReviewRowId, setImportReviewRowId] = useState<string | null>(null);

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

  async function sendAccountEmail(row: LeasePipelineRow) {
    if (emailBusyForRow) return;
    setEmailBusyForRow(row.id);
    try {
      const res = await fetch("/api/portal/send-resident-welcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ to: row.residentEmail, residentName: row.residentName, axisId: row.axisId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; mailtoHref?: string };
      if (res.ok && data.ok) {
        showToast("Account setup email sent.");
        onEmailAccountSetup?.(row.residentEmail, row.residentName, row.axisId);
        return;
      }
      if (typeof data.mailtoHref === "string") {
        const { openMailtoHref } = await import("@/lib/resident-welcome-email");
        openMailtoHref(data.mailtoHref);
        showToast("Email provider not configured. Opened a draft in your mail app.");
        return;
      }
      showToast(data.error ?? "Could not send account setup email.");
    } catch {
      showToast("Could not send account setup email.");
    } finally {
      setEmailBusyForRow(null);
    }
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

  const generationGate = (row: LeasePipelineRow) => leaseGenerationSupportedForRow(row);
  const hasLeaseDocument = (row: LeasePipelineRow) => Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);
  void refreshKey;
  const bucketRows = useMemo(() => rows.filter((r) => leaseRowMatchesManagerTab(r, tab)), [rows, tab]);
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

  const runGenerateLease = (row: LeasePipelineRow) => {
    if (generatingRowId) return;
    setGenerateLeaseRow(resolveManagerLeaseGenerationRow(row.id, managerUserId) ?? row);
  };

  const handleLeaseGenerated = (_rowId: string) => {
    setGenerateLeaseRow(null);
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

  const renderLeaseHeaderActions = (row: LeasePipelineRow) => {
    const generation = generationGate(row);
    const canEditDocument = leaseAllowsManagerDocumentEdits(row);
    const canEditGeneratedBody = canEditDocument && Boolean(row.generatedHtml) && !row.managerUploadedPdf?.dataUrl && !row.templateDocumentUrl;
    const showGenerate = canEditDocument;
    const needsAccountEmail =
      (row.status === "Manager Review" || row.status === "Draft") &&
      !residentAccountEmails.has(row.residentEmail.trim().toLowerCase());

    const hasDocument = hasLeaseDocument(row);
    // Every reason `sendLeaseToResident` would refuse, in the same order, so the
    // manager gets a sentence rather than a mystery.
    const sendBlockedReason = !residentAccountEmails.has(row.residentEmail.trim().toLowerCase())
      ? "Resident must create their PropLane resident account before you can send the lease."
      : !row.generatedHtml && !row.managerUploadedPdf?.dataUrl
        ? "Generate or upload a lease document first."
        : // Unapproved applicant, a document that disagrees with the record, or
          // an import nobody has confirmed. `sendLeaseToResident` refuses on the
          // same three; this is the affordance.
          sendGateBlockerForRender(row);
    const showSendToResident = row.status === "Manager Review" || row.status === "Draft";
    const showDelete = row.status !== "Fully Signed";
    const showMoveToReview = row.status === "Resident Signature Pending";
    const showManagerSign = !row.managerSignature && residentHasSignedLease(row);
    const showSigningReminder = row.status === "Resident Signature Pending";
    const showRenewals = hasBothLeaseSignatures(row) && row.status === "Fully Signed";

    const uploadLabel = pendingRowId === row.id ? "Uploading…" : hasDocument ? "Upload" : "Upload PDF";

    const triggerUpload = () => {
      // Not a render-phase write: triggerUpload is only ever passed as onClick/onSelect.
      // The compiler flags it because the closure is created during render.
      // eslint-disable-next-line react-hooks/refs
      uploadTargetRowIdRef.current = row.id;
      uploadRef.current?.click();
    };

    const signButton = showManagerSign ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-manager-sign"
        onClick={() => onManagerSign(row)}
      >
        Sign
      </Button>
    ) : showSigningReminder ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-signing-reminder"
        disabled={reminderBusyForRow === row.id}
        title="Send signing reminder"
        onClick={() => openLeaseSigningReminderPreview(row)}
      >
        {reminderBusyForRow === row.id ? "Sending…" : "Send reminder"}
      </Button>
    ) : null;

    const sendToResidentButton = showSendToResident ? (
      // Disabled only while this row's send is in flight, never for a gate
      // reason. Disabling for a reason makes the click handler — the only thing
      // that states that reason and opens the review which clears it —
      // unreachable, and `title` is invisible on touch, so a blocked Send became
      // a dead button with no sentence anywhere. The gate is
      // `sendLeaseToResident`, never the button ("greying out a button is not
      // the gate"), so an enabled Send that explains itself is strictly safer.
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-send-resident"
        disabled={sendingToResidentRowId === row.id}
        title={sendBlockedReason ?? undefined}
        onClick={() => openSendLeasePreview(row)}
      >
        {sendingToResidentRowId === row.id ? "Sending…" : "Send"}
      </Button>
    ) : null;

    const editButton = canEditGeneratedBody ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-edit"
        onClick={() => setEditLeaseRowId(row.id)}
      >
        Edit
      </Button>
    ) : null;

    const downloadButton = hasDocument ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-download"
        onClick={() => onDownload(row)}
      >
        Download
      </Button>
    ) : null;

    const generateButton = showGenerate ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-generate"
        disabled={generatingRowId === row.id || !generation.ok}
        title={generation.ok ? undefined : generation.error}
        onClick={() => runGenerateLease(row)}
      >
        {generatingRowId === row.id ? "Generating…" : hasLeaseDocument(row) ? "Regenerate" : "Generate lease"}
      </Button>
    ) : null;

    const showReviewImport = Boolean(row.uploadedLeaseParse);
    // The CTA predicate, not the send gate — see lease-pipeline-storage.
    const importNeedsReview = leaseNeedsUploadedLeaseReviewAction(row);
    const reviewImportLabel = importNeedsReview ? "Review import" : "Imported lease";
    const reviewImportButton = showReviewImport ? (
      <Button
        type="button"
        variant={importNeedsReview ? "primary" : "outline"}
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-review-import"
        onClick={() => setImportReviewRowId(row.id)}
      >
        {reviewImportLabel}
      </Button>
    ) : null;

    const uploadButton = canEditDocument ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        onClick={triggerUpload}
        disabled={pendingRowId === row.id}
      >
        {uploadLabel}
      </Button>
    ) : null;

    const deleteButton = showDelete ? (
      <Button
        type="button"
        variant="outline"
        className={`${RESIDENT_DETAIL_HEADER_ACTION_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
        data-attr="lease-delete"
        onClick={() => onDeleteLease(row)}
      >
        Delete
      </Button>
    ) : null;

    const moveToReviewButton = showMoveToReview ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-move-manager-review"
        onClick={() => onMoveToManagerReview(row)}
      >
        Move to review
      </Button>
    ) : null;

    const renewButton = showRenewals ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="lease-renew"
        onClick={() => {
          setRenewInitialTerm(undefined);
          setRenewLeaseRow(row);
        }}
      >
        Renew lease
      </Button>
    ) : null;

    const extendButton = showRenewals ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        onClick={() => setAmendLeaseRow(row)}
      >
        Extend move-out
      </Button>
    ) : null;

    const emailSetupButton = needsAccountEmail ? (
      <Button
        type="button"
        variant="outline"
        className={`${RESIDENT_DETAIL_HEADER_ACTION_BTN} bg-primary/[0.06] text-primary hover:bg-primary/[0.12]`}
        disabled={emailBusyForRow === row.id}
        onClick={() => sendAccountEmail(row)}
      >
        {emailBusyForRow === row.id ? "Sending…" : "Email setup"}
      </Button>
    ) : null;

    const hasMobileOverflow =
      hasDocument ||
      canEditDocument ||
      showReviewImport ||
      showDelete ||
      showGenerate ||
      showMoveToReview ||
      showRenewals ||
      needsAccountEmail;

    const mobileOverflowMenu = hasMobileOverflow ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={`${RESIDENT_DETAIL_HEADER_ACTION_BTN} max-md:px-2.5 max-md:text-base`}
            data-attr="lease-more-actions"
            aria-label="More lease actions"
          >
            …
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" backdrop>
          {hasDocument ? (
            <DropdownMenuItem data-attr="lease-download" onSelect={() => onDownload(row)}>
              Download
            </DropdownMenuItem>
          ) : null}
          {canEditDocument ? (
            <DropdownMenuItem
              data-attr="lease-upload"
              disabled={pendingRowId === row.id}
              onSelect={triggerUpload}
            >
              {uploadLabel}
            </DropdownMenuItem>
          ) : null}
          {showReviewImport ? (
            <DropdownMenuItem data-attr="lease-review-import" onSelect={() => setImportReviewRowId(row.id)}>
              {reviewImportLabel}
            </DropdownMenuItem>
          ) : null}
          {showDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-attr="lease-delete"
                className="text-[var(--status-overdue-fg)] focus:text-[var(--status-overdue-fg)]"
                onSelect={() => onDeleteLease(row)}
              >
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
          {showGenerate ? (
            <DropdownMenuItem
              data-attr="lease-generate"
              disabled={generatingRowId === row.id || !generation.ok}
              onSelect={() => runGenerateLease(row)}
            >
              {generatingRowId === row.id ? "Generating…" : hasLeaseDocument(row) ? "Regenerate" : "Generate lease"}
            </DropdownMenuItem>
          ) : null}
          {showMoveToReview ? (
            <DropdownMenuItem data-attr="lease-move-manager-review" onSelect={() => onMoveToManagerReview(row)}>
              Move to review
            </DropdownMenuItem>
          ) : null}
          {showRenewals ? (
            <>
              <DropdownMenuItem
                data-attr="lease-renew"
                onSelect={() => {
                  setRenewInitialTerm(undefined);
                  setRenewLeaseRow(row);
                }}
              >
                Renew lease
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAmendLeaseRow(row)}>Extend move-out</DropdownMenuItem>
            </>
          ) : null}
          {needsAccountEmail ? (
            <DropdownMenuItem disabled={emailBusyForRow === row.id} onSelect={() => void sendAccountEmail(row)}>
              {emailBusyForRow === row.id ? "Sending…" : "Email setup"}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

    return (
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
        <PortalSectionActionRow variant="header" className={RESIDENT_DETAIL_HEADER_ACTIONS_ROW}>
          <div className="flex max-w-full flex-nowrap items-center gap-1 md:hidden">
            {sendToResidentButton}
            {signButton}
            {editButton}
            {mobileOverflowMenu}
          </div>
          <div className="hidden max-w-full flex-nowrap items-center gap-1 md:flex">
            {sendToResidentButton}
            {signButton}
            {editButton}
            {downloadButton}
            {generateButton}
            {reviewImportButton}
            {uploadButton}
            {moveToReviewButton}
            {renewButton}
            {extendButton}
            {emailSetupButton}
            {deleteButton}
          </div>
        </PortalSectionActionRow>
      </div>
    );
  };

  const renderLeaseRowDetail = (row: LeasePipelineRow) => <LeaseDocumentPreview row={row} />;

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
        footerNote="The lease will be released to the resident portal after you confirm. This message is delivered to PropLane inbox and email."
        confirmLabel="Send lease & notification"
        confirmLabelWithoutMessage="Send lease only"
        confirmBusy={Boolean(leaseSentPreview && sendingToResidentRowId === leaseSentPreview.row.id)}
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
        showChannelPicker
        emailAvailable
        smsAvailable
        confirmLabel="Send reminder"
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
          onOpenRenew={(leaseTerm) => {
            const row = amendLeaseRow;
            setAmendLeaseRow(null);
            if (!row) return;
            setRenewLeaseRow(row);
            setRenewInitialTerm(leaseTerm);
          }}
          onSuccess={() => void handleAmendLeaseSuccess()}
        />
      ) : null}

      {editLeaseRowId && detailRow && editLeaseRowId === detailRow.id ? (
        <ManagerPipelineLeaseEditModal
          open
          row={detailRow}
          onClose={() => setEditLeaseRowId(null)}
          onDone={() => void syncLeasePipelineFromServer(managerUserId, { force: true })}
        />
      ) : null}

      <LeaseGenerateModal
        open={generateLeaseRow !== null}
        row={generateLeaseRow}
        managerUserId={managerUserId}
        busy={Boolean(generateLeaseRow && generatingRowId === generateLeaseRow.id)}
        replacesManagerEdits={Boolean(generateLeaseRow?.generatedHtml || generateLeaseRow?.managerUploadedPdf?.dataUrl)}
        onClose={() => {
          if (!generatingRowId) setGenerateLeaseRow(null);
        }}
        onGenerated={handleLeaseGenerated}
      />

      {renewLeaseRow ? (
        <LeaseRenewModal
          open
          onClose={() => {
            setRenewLeaseRow(null);
            setRenewInitialTerm(undefined);
          }}
          initialLeaseTerm={renewInitialTerm}
          currentEnd={renewLeaseRow.application?.leaseEnd ?? ""}
          currentTerm={renewLeaseRow.application?.leaseTerm ?? ""}
          currentRentLabel={renewLeaseRow.signedRentLabel ?? renewLeaseRow.application?.managerRentOverride ?? ""}
          propertyId={renewLeaseRow.propertyId ?? renewLeaseRow.application?.propertyId ?? ""}
          currentRentalType={renewLeaseRow.application?.rentalType}
          leaseId={renewLeaseRow.id}
          onSuccess={() => void handleAmendLeaseSuccess()}
        />
      ) : null}
    </>
  );

  if (leaseIdProp && detailRow) {
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
          inlineActions
          actions={renderLeaseHeaderActions(detailRow)}
          pinScrollBody
        >
          {renderLeaseRowDetail(detailRow)}
        </PortalRecordDetailPage>
      </>
    );
  }

  if (bucketRows.length === 0) {
    return (
      <>
        {leaseModals}
        {onAddLease ? (
          <div className="px-3 py-3 max-md:px-2.5">
            <PortalListAddRow
              label="Add"
              icon={PORTAL_LIST_ADD_ICONS.lease}
              onClick={onAddLease}
              dataAttr="leases-list-add"
            />
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      {leaseModals}
      <div className={INBOX_LIST_SCROLL}>
        {bucketRows.map((row) => (
          <PortalPersonRecordRow
            key={row.id}
            name={row.residentName}
            subtitle={row.unit}
            preview={
              row.pendingRenewal && row.status === "Manager Review"
                ? "Renewal requested · Manager Review"
                : row.status
            }
            meta={row.updated}
            badge={
              row.pendingRenewal ? (
                <Badge tone="warning">Renewal requested</Badge>
              ) : row.leaseKind === "joint_bundle" ? (
                <Badge tone="neutral">Joint bundle</Badge>
              ) : undefined
            }
            onOpen={() => openLeaseDetail(row)}
            dataAttr="lease-list-row"
          />
        ))}
        {onAddLease ? (
          <div className="px-3 py-3 max-md:px-2.5">
            <PortalListAddRow
              label="Add"
              icon={PORTAL_LIST_ADD_ICONS.lease}
              onClick={onAddLease}
              dataAttr="leases-list-add"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
