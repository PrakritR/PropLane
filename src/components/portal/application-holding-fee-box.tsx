"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  buildHoldingFeeNoticeBody,
  deliverPortalInboxMessage,
} from "@/lib/portal-message-delivery";
import {
  findHoldingDepositCharge,
  removeApplicantHoldingFee,
  setApplicantHoldingFee,
} from "@/lib/household-charges";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { getPropertyById } from "@/lib/rental-application/data";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";

/**
 * Why a holding fee cannot be asked for on this row yet, or "" when it can.
 *
 * A charge is scoped to (applicant, property), so both have to exist before one
 * can be written at all.
 */
function applicationHoldingFeeBlockedReason(residentEmail: string, propertyId: string): string {
  if (!propertyId.trim()) {
    return "This application has no house on it yet, so a holding fee has nothing to be charged against. It becomes available once a home is selected.";
  }
  if (!residentEmail.includes("@")) {
    return "This application has no email address on it yet, so there is nobody to bill a holding fee to.";
  }
  return "";
}

function formatHoldingFeeAmountLabel(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function resolveHoldingFeePropertyLabel(propertyId: string, existingLabel?: string): string {
  if (existingLabel?.trim()) return existingLabel.trim();
  const prop = getPropertyById(propertyId);
  return prop?.title ?? prop?.listingSubmission?.buildingName ?? "";
}

export type HoldingFeeNoticeDraft = {
  amount: number;
  amountLabel: string;
  propertyLabel: string;
};

/**
 * Manager-entered holding fee for ONE applicant, shown on the application detail.
 *
 * PropLane stopped auto-collecting a holding deposit at application time in
 * 2026-07 (deposits moved under Payments, after approval), which left managers
 * with no way to ask for a hold at all. This is the replacement: opt-in, per
 * applicant, with the manager choosing the amount — never automatic.
 *
 * A hold the applicant has already PAID is never re-priced or deleted from
 * here: the money has moved, and whether it is refundable is a lease-terms
 * question between the manager and the applicant, not something this box should
 * silently decide.
 *
 * Writes go through the parent modal's notification preview (same pattern as
 * Tours / Add payment) — this box only collects the amount and opens review.
 */
export function ApplicationHoldingFeeBox({
  applicationId,
  residentEmail,
  residentName,
  residentUserId,
  propertyId,
  managerUserId,
  onChanged,
  onReview,
  bare = false,
  busy = false,
}: {
  applicationId: string;
  residentEmail: string;
  residentName: string;
  residentUserId: string | null;
  propertyId: string;
  managerUserId: string | null;
  onChanged?: () => void;
  /** Opens the shared notification preview instead of writing immediately. */
  onReview: (draft: HoldingFeeNoticeDraft) => void;
  /** Inside the modal the surrounding card and repeated title are noise. */
  bare?: boolean;
  busy?: boolean;
}) {
  const { showToast } = useAppUi();
  const existing =
    residentEmail && propertyId
      ? findHoldingDepositCharge(residentEmail, propertyId, residentUserId, applicationId)
      : undefined;
  const [amount, setAmount] = useState(() =>
    existing ? existing.amountLabel.replace(/[^0-9.]/g, "") : "",
  );
  const [removeBusy, setRemoveBusy] = useState(false);

  const paid = existing?.status === "paid";
  const demo = isDemoModeActive();
  const controlsBusy = busy || removeBusy;

  // Inline the card is simply absent when no charge can be scoped; inside the
  // modal it has to SAY so, or the manager gets a title over an empty body with
  // no explanation and nothing to act on.
  const blockedReason = applicationHoldingFeeBlockedReason(residentEmail, propertyId);
  if (blockedReason) {
    if (!bare) return null;
    return (
      <p className="text-sm text-muted" data-attr="application-holding-fee-unavailable">
        {blockedReason}
      </p>
    );
  }

  const review = () => {
    if (demo) {
      showToast("Holding fees are read-only in the demo.");
      return;
    }
    const amt = Number.parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      showToast("Enter a holding fee amount greater than $0.");
      return;
    }
    if (amt > 100_000) {
      showToast("That holding fee looks too large — check the amount.");
      return;
    }
    onReview({
      amount: amt,
      amountLabel: formatHoldingFeeAmountLabel(Number(amt.toFixed(2))),
      propertyLabel: resolveHoldingFeePropertyLabel(propertyId, existing?.propertyLabel),
    });
  };

  const remove = async () => {
    setRemoveBusy(true);
    try {
      const result = removeApplicantHoldingFee({
        residentEmail,
        propertyId,
        residentUserId,
        applicationId,
      });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setAmount("");
      showToast("Holding fee removed.");
      onChanged?.();
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <div
      className={bare ? "" : "rounded-xl border border-border bg-card/40 px-4 py-3"}
      data-attr="application-holding-fee-box"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {bare ? <span /> : <p className="text-sm font-semibold text-foreground">Holding fee</p>}
        {existing ? (
          <span
            className={`text-xs font-semibold ${paid ? "text-emerald-700" : "text-muted"}`}
            data-attr="application-holding-fee-status"
          >
            {paid ? `Paid · ${existing.amountLabel}` : `Awaiting payment · ${existing.amountLabel}`}
          </span>
        ) : null}
      </div>
      <p className={`${bare ? "" : "mt-1 "}text-xs text-muted`}>
        Optional. You’ll review the message to the applicant on the next step — same flow as Tours
        and Add payment. The same amount credits toward their security deposit when you approve —
        deposit and move-in fee charges are only billed at approval.
      </p>

      {paid ? (
        <p className="mt-2 text-xs text-muted">
          Already paid, so the amount is locked here. Handle any refund with the applicant directly per
          your lease terms.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">
              $
            </span>
            <Input
              type="number"
              inputMode="decimal"
              min={1}
              step="0.01"
              placeholder="500"
              aria-label="Holding fee amount"
              className="w-36 pl-7"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={controlsBusy}
              data-attr="application-holding-fee-amount"
            />
          </div>
          <Button
            type="button"
            variant="primary"
            className="h-9 min-h-0 rounded-full px-4 text-[13px]"
            disabled={controlsBusy || !amount.trim()}
            onClick={() => review()}
            data-attr="application-holding-fee-preview"
          >
            Preview & update
          </Button>
          {existing ? (
            <Button
              type="button"
              variant="danger"
              className="h-9 min-h-0 px-4 text-[13px]"
              disabled={controlsBusy}
              onClick={() => remove()}
              data-attr="application-holding-fee-remove"
            >
              Remove
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The holding fee as a top-right header action rather than a body card.
 *
 * Two-step write (Add payment / Tours pattern): amount modal →
 * `PortalNotificationPreviewModal` → save fee + optional notice.
 *
 * `key` on the box is deliberate: it seeds its amount field from the charge
 * that exists at mount, so without a per-application key the modal would show
 * the previous applicant's amount when reopened on another row.
 */
export function ApplicationHoldingFeeModal({
  row,
  open,
  onClose,
  onChanged,
}: {
  row: {
    id: string;
    email?: string | null;
    name?: string | null;
    residentUserId?: string | null;
    managerUserId?: string | null;
    propertyId?: string | null;
    application?: { propertyId?: string | null } | null;
  } | null;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { showToast } = useAppUi();
  const [noticePreview, setNoticePreview] = useState<HoldingFeeNoticeDraft | null>(null);
  const [noticeBusy, setNoticeBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setNoticePreview(null);
      setNoticeBusy(false);
    }
  }, [open]);

  if (!row) return null;
  const propertyId = row.application?.propertyId?.trim() || row.propertyId?.trim() || "";
  const residentEmail = row.email ?? "";
  const residentName = row.name ?? "";
  const residentUserId = row.residentUserId ?? null;
  const managerUserId = row.managerUserId ?? null;
  const existing =
    residentEmail && propertyId
      ? findHoldingDepositCharge(residentEmail, propertyId, residentUserId, row.id)
      : undefined;

  const handleClose = () => {
    setNoticePreview(null);
    onClose();
  };

  const confirmHoldingFee = async (
    skipMessage: boolean,
    channels?: { viaEmail: boolean; viaSms: boolean },
    draft?: { subject: string; body: string },
  ) => {
    if (!noticePreview || noticeBusy) return;
    if (isDemoModeActive()) {
      showToast("Holding fees are read-only in the demo.");
      return;
    }
    setNoticeBusy(true);
    try {
      const result = setApplicantHoldingFee({
        residentEmail,
        residentName,
        residentUserId,
        propertyId,
        applicationId: row.id,
        managerUserId,
        amount: noticePreview.amount,
      });
      if (!result.ok) {
        showToast(result.error);
        return;
      }

      onChanged?.();

      if (result.alreadyPaid) {
        showToast("This holding fee is already paid — the amount was left unchanged.");
        setNoticePreview(null);
        onClose();
        return;
      }

      if (skipMessage) {
        showToast(
          `Holding fee of ${result.charge.amountLabel} saved for ${result.charge.residentName} (no notification sent).`,
        );
        setNoticePreview(null);
        onClose();
        return;
      }

      const subject = draft?.subject?.trim() || `Holding fee due: ${result.charge.amountLabel}`;
      const body =
        draft?.body?.trim() ||
        buildHoldingFeeNoticeBody({
          residentName: residentName.trim() || "there",
          residentEmail,
          amountLabel: result.charge.amountLabel,
          propertyLabel: result.charge.propertyLabel || noticePreview.propertyLabel,
        });
      const notice = await deliverPortalInboxMessage({
        eventCategory: "payments",
        toEmails: [residentEmail],
        subject,
        text: body,
        deliverViaEmail: channels?.viaEmail !== false,
        deliverViaSms: channels?.viaSms !== false,
      });

      if (notice.ok) {
        showToast(
          notice.skipped
            ? "Holding fee saved. Notice sent (sandbox email skipped; SMS/inbox when available)."
            : "Holding fee saved and notice sent via inbox, email, and SMS when available.",
        );
      } else {
        showToast(
          notice.error
            ? `Holding fee saved, but notice failed: ${notice.error}`
            : "Holding fee saved, but notice could not be sent.",
        );
      }
      setNoticePreview(null);
      onClose();
    } finally {
      setNoticeBusy(false);
    }
  };

  const previewBody =
    noticePreview &&
    buildHoldingFeeNoticeBody({
      residentName: residentName.trim() || "there",
      residentEmail,
      amountLabel: noticePreview.amountLabel,
      propertyLabel: noticePreview.propertyLabel,
    });

  const hasExistingUnpaid = Boolean(existing && existing.status !== "paid");

  return (
    <>
      <Modal
        open={open && noticePreview === null}
        onClose={handleClose}
        title="Holding fee"
        description={`Ask ${residentName.trim() || "this applicant"} to hold the home while you review.`}
        dataAttr="application-holding-fee-modal"
      >
        <ApplicationHoldingFeeBox
          bare
          key={row.id}
          applicationId={row.id}
          residentEmail={residentEmail}
          residentName={residentName}
          residentUserId={residentUserId}
          propertyId={propertyId}
          managerUserId={managerUserId}
          busy={noticeBusy}
          onChanged={onChanged}
          onReview={setNoticePreview}
        />
      </Modal>

      <PortalNotificationPreviewModal
        open={noticePreview !== null}
        title="Holding fee — notification preview"
        intro="Review the message before updating the fee."
        onClose={() => setNoticePreview(null)}
        recipient={residentEmail}
        subject={noticePreview ? `Holding fee due: ${noticePreview.amountLabel}` : ""}
        body={previewBody ?? ""}
        showChannelPicker
        emailAvailable={residentEmail.includes("@")}
        smsAvailable
        deliverViaKind="payments"
        confirmLabel={hasExistingUnpaid ? "Update fee & send notice" : "Add fee & send notice"}
        confirmLabelWithoutMessage={hasExistingUnpaid ? "Update fee only" : "Add fee only"}
        confirmBusy={noticeBusy}
        confirmBusyLabel="Saving…"
        cancelLabel="Back"
        skipMessageLabel="Don't message applicant"
        onConfirm={(skipMessage, channels, draft) =>
          void confirmHoldingFee(skipMessage, channels, draft)
        }
      />
    </>
  );
}
