"use client";

import { useMemo, useRef, type ReactNode } from "react";
import {
  BadgeCheck,
  Bell,
  CalendarClock,
  Download,
  FileSearch,
  FilePlus,
  Pencil,
  PenLine,
  RefreshCw,
  Send,
  Trash2,
  Undo2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordShareLinkButton } from "@/components/portal/portal-record-share-link-button";
import { leaseAllowsSignedPdfUpload, leaseCanBeMarkedSignedOffPlatform } from "@/lib/lease-execution-evidence";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  hasBothLeaseSignatures,
  leaseNeedsUploadedLeaseReviewAction,
  leaseAwaitingManagerCountersign,
  leaseUploadedImportFooterLabel,
  managerLeaseSignButtonLabel,
} from "@/lib/lease-pipeline-storage";

type LeaseIconAction = {
  id: string;
  node: ReactNode;
};

type LeasePrimaryHeaderActionsProps = {
  row: LeasePipelineRow;
  downloadLabel?: string;
  deleteLabel?: string;
  onDownload: () => void;
  onSignManager?: () => void;
  onSigningReminder?: () => void;
  signingReminderBusy?: boolean;
  onDelete?: () => void;
  onSendToResident?: () => void;
  /** When set, shows a Share action for a public view URL. */
  shareRecordId?: string;
  sendToResidentBusy?: boolean;
  sendToResidentDisabled?: boolean;
  onMoveToManagerReview?: () => void;
  onGenerateLease?: () => void;
  generateLeaseBusy?: boolean;
  generateLeaseDisabled?: boolean;
  generateLeaseTitle?: string;
  onUploadPdf?: (file: File) => Promise<void>;
  uploadPdfBusy?: boolean;
  /**
   * Files the lease as executed off-platform. Offered only while the row carries
   * no execution evidence (`leaseCanBeMarkedSignedOffPlatform`); the route
   * re-checks the same predicate.
   */
  onMarkSigned?: () => void;
  markSignedDataAttr?: string;
  /** Opens the imported-lease review. Shown whenever the row carries a parse. */
  onReviewImportedLease?: () => void;
  /** Section editor for this lease packet only — never the property template. */
  onEditLease?: () => void;
  editLeaseDataAttr?: string;
  canEditDocument?: boolean;
  downloadDataAttr?: string;
  signManagerDataAttr?: string;
  signingReminderDataAttr?: string;
  deleteDataAttr?: string;
  sendToResidentDataAttr?: string;
  moveToManagerReviewDataAttr?: string;
  /** Opens renew / extend move-out for a fully signed lease. */
  onRenewLease?: () => void;
  onExtendMoveOut?: () => void;
  /** @deprecated Icons sit in the title row; kept so callers need not change. */
  btnClass?: string;
  /** @deprecated Icons sit in the title row; kept so callers need not change. */
  embedded?: boolean;
  /** @deprecated Icons sit in the title row; kept so callers need not change. */
  flatFooter?: boolean;
};

function LeaseHeaderIcon({
  icon,
  label,
  dataAttr,
  onClick,
  disabled,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  dataAttr?: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
}) {
  return (
    <PortalIconAction
      icon={icon}
      label={label}
      tone={tone}
      data-attr={dataAttr}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

/** Download, share, send, edit, delete — icon-only in the lease record header. No ⋯. */
export function LeasePrimaryHeaderActions({
  row,
  downloadLabel = "Download",
  deleteLabel = "Delete",
  onDownload,
  onSignManager,
  onSigningReminder,
  signingReminderBusy = false,
  onDelete,
  onSendToResident,
  shareRecordId,
  sendToResidentBusy = false,
  sendToResidentDisabled = false,
  onMoveToManagerReview,
  onGenerateLease,
  generateLeaseBusy = false,
  generateLeaseDisabled = false,
  generateLeaseTitle,
  onUploadPdf,
  uploadPdfBusy = false,
  onMarkSigned,
  markSignedDataAttr = "lease-primary-mark-signed",
  onReviewImportedLease,
  onRenewLease,
  onExtendMoveOut,
  onEditLease,
  editLeaseDataAttr = "lease-primary-edit",
  canEditDocument = false,
  downloadDataAttr = "lease-primary-download",
  signManagerDataAttr = "lease-primary-sign-manager",
  signingReminderDataAttr = "lease-primary-signing-reminder",
  deleteDataAttr = "lease-primary-delete",
  sendToResidentDataAttr = "lease-primary-send-resident",
  moveToManagerReviewDataAttr = "lease-primary-move-manager-review",
}: LeasePrimaryHeaderActionsProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const hasDocument = Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);

  const showSendToResident =
    hasDocument &&
    (row.status === "Manager Review" || row.status === "Draft") &&
    Boolean(onSendToResident);
  const showSign = leaseAwaitingManagerCountersign(row) && Boolean(onSignManager);
  const showSigningReminder = row.status === "Resident Signature Pending" && Boolean(onSigningReminder);
  const showMoveToReview = row.status === "Resident Signature Pending" && Boolean(onMoveToManagerReview);
  const showGenerate = canEditDocument && Boolean(onGenerateLease);
  const canMarkSigned = leaseCanBeMarkedSignedOffPlatform(row);
  const showUpload = leaseAllowsSignedPdfUpload(row) && Boolean(onUploadPdf);
  const showMarkSigned = canMarkSigned && Boolean(onMarkSigned);
  const showEditLease =
    canEditDocument &&
    Boolean(row.generatedHtml) &&
    !row.managerUploadedPdf?.dataUrl &&
    !row.templateDocumentUrl &&
    Boolean(onEditLease);
  const showRenewals =
    hasBothLeaseSignatures(row) && row.status === "Fully Signed" && Boolean(onRenewLease || onExtendMoveOut);
  const reviewImportLabel = leaseUploadedImportFooterLabel(row);
  const showReviewImport = Boolean(onReviewImportedLease) && Boolean(reviewImportLabel);
  const importNeedsReview = leaseNeedsUploadedLeaseReviewAction(row);
  const signLeaseLabel = managerLeaseSignButtonLabel();

  const headerActions = useMemo(() => {
    const actions: LeaseIconAction[] = [];

    if (hasDocument) {
      actions.push({
        id: "download",
        node: (
          <LeaseHeaderIcon
            icon={Download}
            label={downloadLabel}
            dataAttr={downloadDataAttr}
            onClick={onDownload}
          />
        ),
      });
    }

    if (showSendToResident) {
      actions.push({
        id: "send",
        node: (
          <LeaseHeaderIcon
            icon={Send}
            label={sendToResidentBusy ? "Sending…" : "Send"}
            dataAttr={sendToResidentDataAttr}
            disabled={sendToResidentBusy || sendToResidentDisabled}
            onClick={onSendToResident}
          />
        ),
      });
    }

    if (hasDocument && shareRecordId) {
      actions.push({
        id: "share",
        node: (
          <PortalRecordShareLinkButton
            kind="lease"
            recordId={shareRecordId}
            icon
            dataAttr="lease-share"
            recordTitle={row.residentName?.trim() || row.unit?.trim() || row.propertyId}
          />
        ),
      });
    }

    if (onDelete && hasDocument) {
      actions.push({
        id: "delete",
        node: (
          <LeaseHeaderIcon
            icon={Trash2}
            label={deleteLabel}
            dataAttr={deleteDataAttr}
            tone="danger"
            onClick={onDelete}
          />
        ),
      });
    }

    if (showMoveToReview) {
      actions.push({
        id: "move-review",
        node: (
          <LeaseHeaderIcon
            icon={Undo2}
            label="Move to review"
            dataAttr={moveToManagerReviewDataAttr}
            onClick={onMoveToManagerReview}
          />
        ),
      });
    }

    if (showSign) {
      actions.push({
        id: "sign",
        node: (
          <LeaseHeaderIcon
            icon={PenLine}
            label={signLeaseLabel}
            dataAttr={signManagerDataAttr}
            onClick={onSignManager}
          />
        ),
      });
    } else if (showSigningReminder) {
      actions.push({
        id: "reminder",
        node: (
          <LeaseHeaderIcon
            icon={Bell}
            label={signingReminderBusy ? "Sending…" : "Send reminder"}
            dataAttr={signingReminderDataAttr}
            disabled={signingReminderBusy}
            onClick={onSigningReminder}
          />
        ),
      });
    }

    if (showEditLease) {
      actions.push({
        id: "edit",
        node: (
          <LeaseHeaderIcon
            icon={Pencil}
            label="Edit"
            dataAttr={editLeaseDataAttr}
            onClick={onEditLease}
          />
        ),
      });
    }

    if (showGenerate) {
      actions.push({
        id: "generate",
        node: (
          <LeaseHeaderIcon
            icon={FilePlus}
            label={
              generateLeaseBusy
                ? "Generating…"
                : generateLeaseDisabled && generateLeaseTitle
                  ? generateLeaseTitle
                  : "Generate lease"
            }
            disabled={generateLeaseBusy || generateLeaseDisabled}
            onClick={onGenerateLease}
          />
        ),
      });
    }

    if (showReviewImport && reviewImportLabel) {
      actions.push({
        id: "review-import",
        node: (
          <LeaseHeaderIcon
            icon={FileSearch}
            label={reviewImportLabel}
            dataAttr="lease-primary-review-import"
            tone={importNeedsReview ? "primary" : "default"}
            onClick={onReviewImportedLease}
          />
        ),
      });
    }

    if (showUpload) {
      actions.push({
        id: "upload",
        node: (
          <LeaseHeaderIcon
            icon={Upload}
            label={uploadPdfBusy ? "Uploading…" : "Upload PDF"}
            disabled={uploadPdfBusy}
            onClick={() => uploadInputRef.current?.click()}
          />
        ),
      });
    }

    if (showMarkSigned) {
      actions.push({
        id: "mark-signed",
        node: (
          <LeaseHeaderIcon
            icon={BadgeCheck}
            label="Mark as signed"
            dataAttr={markSignedDataAttr}
            onClick={onMarkSigned}
          />
        ),
      });
    }

    if (showRenewals && onRenewLease) {
      actions.push({
        id: "renew",
        node: (
          <LeaseHeaderIcon icon={RefreshCw} label="Renew" dataAttr="lease-renew" onClick={onRenewLease} />
        ),
      });
    }

    if (showRenewals && onExtendMoveOut) {
      actions.push({
        id: "extend",
        node: (
          <LeaseHeaderIcon
            icon={CalendarClock}
            label="Extend move-out"
            dataAttr="lease-extend"
            onClick={onExtendMoveOut}
          />
        ),
      });
    }

    if (onDelete && !hasDocument) {
      actions.push({
        id: "delete",
        node: (
          <LeaseHeaderIcon
            icon={Trash2}
            label={deleteLabel}
            dataAttr={deleteDataAttr}
            tone="danger"
            onClick={onDelete}
          />
        ),
      });
    }

    return actions;
  }, [
    hasDocument,
    showSendToResident,
    showMoveToReview,
    showSign,
    showSigningReminder,
    showGenerate,
    showUpload,
    showEditLease,
    editLeaseDataAttr,
    onEditLease,
    onDelete,
    downloadDataAttr,
    downloadLabel,
    onDownload,
    sendToResidentDataAttr,
    sendToResidentBusy,
    sendToResidentDisabled,
    onSendToResident,
    shareRecordId,
    row.residentName,
    row.unit,
    row.propertyId,
    moveToManagerReviewDataAttr,
    onMoveToManagerReview,
    signManagerDataAttr,
    onSignManager,
    signingReminderDataAttr,
    signingReminderBusy,
    onSigningReminder,
    generateLeaseBusy,
    generateLeaseDisabled,
    generateLeaseTitle,
    onGenerateLease,
    uploadPdfBusy,
    showMarkSigned,
    markSignedDataAttr,
    onMarkSigned,
    showReviewImport,
    reviewImportLabel,
    importNeedsReview,
    signLeaseLabel,
    showRenewals,
    onRenewLease,
    onExtendMoveOut,
    onReviewImportedLease,
    deleteDataAttr,
    deleteLabel,
  ]);

  const uploadInput = showUpload ? (
    <input
      ref={uploadInputRef}
      type="file"
      accept="application/pdf"
      className="sr-only"
      onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file || !onUploadPdf) return;
        await onUploadPdf(file);
        e.currentTarget.value = "";
      }}
    />
  ) : null;

  return (
    <>
      <div className="flex min-w-0 flex-nowrap items-center justify-end gap-1.5" data-attr="lease-header-icons">
        {headerActions.map((action) => (
          <div key={action.id} className="shrink-0">
            {action.node}
          </div>
        ))}
      </div>
      {uploadInput}
    </>
  );
}
