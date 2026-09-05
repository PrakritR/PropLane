"use client";

import { useMemo, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PortalRecordShareLinkButton } from "@/components/portal/portal-record-share-link-button";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import {
  PortalFooterFitActionRow,
  type PortalFooterFitAction,
} from "@/components/portal/portal-footer-fit-action-row";
import { RESIDENT_DETAIL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseNeedsUploadedLeaseReviewAction, residentHasSignedLease } from "@/lib/lease-pipeline-storage";
import { cn } from "@/lib/utils";

const FOOTER_ACTION_BTN = "h-10 min-w-0 whitespace-nowrap px-2.5 text-xs sm:px-3";

type LeaseFooterAction = PortalFooterFitAction;

type LeasePrimaryHeaderActionsProps = {
  row: LeasePipelineRow;
  btnClass?: string;
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
  /** Render buttons only — parent supplies PortalSectionActionRow / footer shell. */
  embedded?: boolean;
  /** With embedded, use the same left-aligned fit row on all breakpoints (resident detail dock). */
  flatFooter?: boolean;
};

/** Download, sign, send — Appendix C3 aligned action row for lease detail surfaces. */
export function LeasePrimaryHeaderActions({
  row,
  btnClass = RESIDENT_DETAIL_HEADER_ACTION_BTN,
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
  onReviewImportedLease,
  onEditLease,
  editLeaseDataAttr = "lease-primary-edit",
  canEditDocument = false,
  downloadDataAttr = "lease-primary-download",
  signManagerDataAttr = "lease-primary-sign-manager",
  signingReminderDataAttr = "lease-primary-signing-reminder",
  deleteDataAttr = "lease-primary-delete",
  sendToResidentDataAttr = "lease-primary-send-resident",
  moveToManagerReviewDataAttr = "lease-primary-move-manager-review",
  embedded = false,
  flatFooter = false,
}: LeasePrimaryHeaderActionsProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const hasDocument = Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);

  const showSendToResident =
    hasDocument &&
    (row.status === "Manager Review" || row.status === "Draft") &&
    Boolean(onSendToResident);
  const showSign = !row.managerSignature && residentHasSignedLease(row) && Boolean(onSignManager);
  const showSigningReminder = row.status === "Resident Signature Pending" && Boolean(onSigningReminder);
  const showMoveToReview = row.status === "Resident Signature Pending" && Boolean(onMoveToManagerReview);
  const showGenerate = canEditDocument && Boolean(onGenerateLease);
  const showUpload = canEditDocument && Boolean(onUploadPdf);
  const showEditLease =
    canEditDocument &&
    Boolean(row.generatedHtml) &&
    !row.managerUploadedPdf?.dataUrl &&
    !row.templateDocumentUrl &&
    Boolean(onEditLease);
  // Not gated on `canEditDocument`: once a lease is out for signature the
  // manager can no longer replace the document, but they must still be able to
  // read what PropLane extracted from it.
  const showReviewImport = Boolean(row.uploadedLeaseParse) && Boolean(onReviewImportedLease);
  // The CTA predicate, not the send gate: it is scoped to rows where
  // confirming can actually succeed, so this button is never a nag whose
  // action always fails.
  const importNeedsReview = leaseNeedsUploadedLeaseReviewAction(row);

  const compactBtnClass = cn(btnClass, FOOTER_ACTION_BTN);
  const deleteBtnClass = cn(
    compactBtnClass,
    "border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline",
  );

  const footerActions = useMemo(() => {
    const actions: LeaseFooterAction[] = [];

    if (hasDocument) {
      actions.push({
        id: "download",
        button: (
          <Button
            type="button"
            variant="outline"
            className={compactBtnClass}
            data-attr={downloadDataAttr}
            onClick={onDownload}
          >
            {downloadLabel}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr={downloadDataAttr} onClick={onDownload}>
            {downloadLabel}
          </DropdownMenuItem>
        ),
      });
    }

    if (showSendToResident) {
      actions.push({
        id: "send",
        button: (
          <Button
            type="button"
            variant="outline"
            className={compactBtnClass}
            data-attr={sendToResidentDataAttr}
            disabled={sendToResidentBusy || sendToResidentDisabled}
            onClick={onSendToResident}
          >
            {sendToResidentBusy ? "Sending…" : "Send"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr={sendToResidentDataAttr}
            disabled={sendToResidentBusy || sendToResidentDisabled}
            onClick={onSendToResident}
          >
            {sendToResidentBusy ? "Sending…" : "Send"}
          </DropdownMenuItem>
        ),
      });
    }

    if (hasDocument && shareRecordId) {
      actions.push({
        id: "share",
        button: (
          <PortalRecordShareLinkButton
            kind="lease"
            recordId={shareRecordId}
            className={compactBtnClass}
            dataAttr="lease-share"
            recordTitle={row.residentName?.trim() || row.unit?.trim() || row.propertyId}
          />
        ),
        menuItem: (
          <PortalRecordShareLinkButton
            kind="lease"
            recordId={shareRecordId}
            menuItem
            dataAttr="lease-share-menu"
            recordTitle={row.residentName?.trim() || row.unit?.trim() || row.propertyId}
          />
        ),
      });
    }

    if (onDelete && hasDocument) {
      actions.push({
        id: "delete",
        button: (
          <Button
            type="button"
            variant="outline"
            className={deleteBtnClass}
            data-attr={deleteDataAttr}
            onClick={onDelete}
          >
            {deleteLabel}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            className="text-rose-800 focus:text-rose-800"
            data-attr={deleteDataAttr}
            onClick={onDelete}
          >
            {deleteLabel}
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
            className={compactBtnClass}
            data-attr={moveToManagerReviewDataAttr}
            onClick={onMoveToManagerReview}
          >
            Move to review
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr={moveToManagerReviewDataAttr} onClick={onMoveToManagerReview}>
            Move to review
          </DropdownMenuItem>
        ),
      });
    }

    if (showSign) {
      actions.push({
        id: "sign",
        button: (
          <Button
            type="button"
            variant="outline"
            className={compactBtnClass}
            data-attr={signManagerDataAttr}
            onClick={onSignManager}
          >
            Sign
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr={signManagerDataAttr} onClick={onSignManager}>
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
            className={compactBtnClass}
            data-attr={signingReminderDataAttr}
            disabled={signingReminderBusy}
            title="Send signing reminder"
            onClick={onSigningReminder}
          >
            {signingReminderBusy ? "Sending…" : "Send reminder"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr={signingReminderDataAttr}
            disabled={signingReminderBusy}
            onClick={onSigningReminder}
          >
            {signingReminderBusy ? "Sending…" : "Send reminder"}
          </DropdownMenuItem>
        ),
      });
    }

    if (showEditLease) {
      actions.push({
        id: "edit",
        button: (
          <Button
            type="button"
            variant="outline"
            className={compactBtnClass}
            data-attr={editLeaseDataAttr}
            onClick={onEditLease}
          >
            Edit
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr={editLeaseDataAttr} onClick={onEditLease}>
            Edit
          </DropdownMenuItem>
        ),
      });
    }

    if (showGenerate) {
      actions.push({
        id: "generate",
        button: (
          <Button
            type="button"
            variant="outline"
            className={compactBtnClass}
            disabled={generateLeaseBusy || generateLeaseDisabled}
            title={generateLeaseTitle}
            onClick={onGenerateLease}
          >
            {generateLeaseBusy ? "Generating..." : "Generate lease"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            disabled={generateLeaseBusy || generateLeaseDisabled}
            onClick={onGenerateLease}
          >
            {generateLeaseBusy ? "Generating..." : "Generate lease"}
          </DropdownMenuItem>
        ),
      });
    }

    if (showReviewImport) {
      const label = importNeedsReview ? "Review import" : "Imported lease";
      actions.push({
        id: "review-import",
        button: (
          <Button
            type="button"
            variant={importNeedsReview ? "primary" : "outline"}
            className={compactBtnClass}
            data-attr="lease-primary-review-import"
            onClick={onReviewImportedLease}
          >
            {label}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="lease-primary-review-import" onClick={onReviewImportedLease}>
            {label}
          </DropdownMenuItem>
        ),
      });
    }

    if (showUpload) {
      actions.push({
        id: "upload",
        button: (
          <label
            className={cn("inline-flex cursor-pointer items-center", compactBtnClass, "hover:bg-accent/30")}
            onClick={(event) => {
              event.preventDefault();
              uploadInputRef.current?.click();
            }}
          >
            {uploadPdfBusy ? "Uploading..." : "Upload PDF"}
          </label>
        ),
        menuItem: (
          <DropdownMenuItem disabled={uploadPdfBusy} onSelect={() => uploadInputRef.current?.click()}>
            {uploadPdfBusy ? "Uploading..." : "Upload PDF"}
          </DropdownMenuItem>
        ),
      });
    }

    if (onDelete && !hasDocument) {
      actions.push({
        id: "delete",
        button: (
          <Button
            type="button"
            variant="outline"
            className={deleteBtnClass}
            data-attr={deleteDataAttr}
            onClick={onDelete}
          >
            {deleteLabel}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            className="text-rose-800 focus:text-rose-800"
            data-attr={deleteDataAttr}
            onClick={onDelete}
          >
            {deleteLabel}
          </DropdownMenuItem>
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
    compactBtnClass,
    deleteBtnClass,
    downloadDataAttr,
    downloadLabel,
    onDownload,
    sendToResidentDataAttr,
    sendToResidentBusy,
    sendToResidentDisabled,
    onSendToResident,
    shareRecordId,
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
    showReviewImport,
    importNeedsReview,
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

  const desktopButtons = (
    <>
      {footerActions.map((action) => (
        <div key={action.id}>{action.button}</div>
      ))}
    </>
  );

  const fitFooter = (
    <div className="relative w-full min-w-0">
      <PortalFooterFitActionRow actions={footerActions} moreLabel="More lease actions" />
    </div>
  );

  if (embedded) {
    if (flatFooter) {
      return (
        <>
          <div className="relative min-w-0 w-full">
            <PortalFooterFitActionRow actions={footerActions} moreLabel="More lease actions" />
          </div>
          {uploadInput}
        </>
      );
    }
    return (
      <>
        <div className="hidden w-full min-w-0 lg:contents">{desktopButtons}</div>
        <div className="w-full min-w-0 lg:hidden">{fitFooter}</div>
        {uploadInput}
      </>
    );
  }

  return (
    <>
      <div className="hidden lg:block">
        <PortalSectionActionRow variant="header">{desktopButtons}</PortalSectionActionRow>
      </div>
      <div className="w-full min-w-0 lg:hidden">{fitFooter}</div>
      {uploadInput}
    </>
  );
}
