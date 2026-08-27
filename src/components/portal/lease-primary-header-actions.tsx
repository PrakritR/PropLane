"use client";

import { forwardRef, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalRecordShareLinkButton } from "@/components/portal/portal-record-share-link-button";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { RESIDENT_DETAIL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseNeedsUploadedLeaseReviewAction, residentHasSignedLease } from "@/lib/lease-pipeline-storage";
import { cn } from "@/lib/utils";

const FOOTER_ACTION_ROW =
  "flex w-full min-w-0 flex-nowrap items-center justify-start gap-2";
const FOOTER_ACTION_BTN = "h-10 min-w-0 whitespace-nowrap px-2.5 text-xs sm:px-3";
const FOOTER_MORE_BTN =
  "inline-flex h-10 min-h-0 w-10 min-w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card/80 p-0 text-base font-bold leading-none text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-primary/30 hover:bg-card [html[data-theme=dark]_&]:portal-outline-control";

type LeaseFooterAction = {
  id: string;
  button: ReactNode;
  menuItem: ReactNode;
};

const LeaseFooterMoreTrigger = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(function LeaseFooterMoreTrigger(props, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={FOOTER_MORE_BTN}
      aria-label="More lease actions"
      {...props}
    >
      <span aria-hidden>⋯</span>
    </button>
  );
});

function LeaseFitActionRow({ actions }: { actions: LeaseFooterAction[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(actions.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure || actions.length === 0) {
      setVisibleCount(actions.length);
      return;
    }

    const gap = 8;

    const sync = () => {
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;

      const buttons = [...measure.querySelectorAll<HTMLElement>("[data-lease-fit-action]")];
      const widths = buttons.map((node) => node.offsetWidth);
      if (widths.length === 0) return;

      const moreNode = measure.querySelector<HTMLElement>("[data-lease-fit-more]");
      const moreWidth = moreNode?.offsetWidth ?? 40;

      const fitCount = (reserveMore: boolean) => {
        let used = 0;
        let count = 0;
        for (let i = 0; i < widths.length; i++) {
          const width = widths[i] ?? 0;
          const gapBefore = count > 0 ? gap : 0;
          const itemsAfter = widths.length - i - 1;
          const moreReserve = reserveMore && itemsAfter > 0 ? gap + moreWidth : 0;
          if (used + gapBefore + width + moreReserve <= containerWidth) {
            used += gapBefore + width;
            count++;
          } else {
            break;
          }
        }
        return count;
      };

      let count = fitCount(false);
      if (count < widths.length) {
        count = fitCount(true);
      }
      setVisibleCount(Math.max(1, Math.min(count, widths.length)));
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(container);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [actions]);

  if (actions.length === 0) return null;

  const visible = actions.slice(0, visibleCount);
  const overflow = actions.slice(visibleCount);

  return (
    <>
      <div
        ref={measureRef}
        className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex gap-2"
        aria-hidden
      >
        {actions.map((action) => (
          <div key={action.id} data-lease-fit-action>
            {action.button}
          </div>
        ))}
        <div data-lease-fit-more>
          <LeaseFooterMoreTrigger />
        </div>
      </div>
      <div ref={containerRef} className={FOOTER_ACTION_ROW}>
        {visible.map((action) => (
          <div key={action.id} className="shrink-0">
            {action.button}
          </div>
        ))}
        {overflow.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <LeaseFooterMoreTrigger />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="z-[60] min-w-[12rem]">
              {overflow
                .filter((action) => action.id !== "delete")
                .map((action) => (
                  <div key={action.id}>{action.menuItem}</div>
                ))}
              {overflow.some((action) => action.id !== "delete") &&
              overflow.some((action) => action.id === "delete") ? (
                <DropdownMenuSeparator />
              ) : null}
              {overflow
                .filter((action) => action.id === "delete")
                .map((action) => (
                  <div key={action.id}>{action.menuItem}</div>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </>
  );
}

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
    (row.status === "Manager Review" || row.status === "Draft") && Boolean(onSendToResident);
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
      <LeaseFitActionRow actions={footerActions} />
    </div>
  );

  if (embedded) {
    if (flatFooter) {
      return (
        <>
          <div className="relative min-w-0 w-full">
            <LeaseFitActionRow actions={footerActions} />
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
