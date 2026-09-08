"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
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
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
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
 * Amount field for ONE applicant's holding fee — the BODY of the modal below.
 *
 * PropLane stopped auto-collecting a holding deposit at application time in
 * 2026-07 (deposits moved under Payments, after approval), which left managers
 * with no way to ask for a hold at all. This is the replacement: opt-in, per
 * applicant, with the manager choosing the amount — never automatic.
 *
 * A hold the applicant has already PAID is never re-priced or deleted from
 * here: the money has moved, and whether it is refundable is a lease-terms
 * question between the manager and the applicant, not something this should
 * silently decide.
 *
 * The amount is CONTROLLED by the modal, and the actions live in the modal
 * footer, because the house popup shape puts its buttons bottom-right rather
 * than inline beside the field.
 */
export function ApplicationHoldingFeeBox({
  amount,
  onAmountChange,
  existingLabel,
  paid,
  blockedReason,
  busy = false,
}: {
  amount: string;
  onAmountChange: (next: string) => void;
  /** Set when a hold already exists on this row, for the status chip. */
  existingLabel?: string;
  paid: boolean;
  /** Non-empty when no hold can be scoped to this row yet. */
  blockedReason: string;
  busy?: boolean;
}) {
  if (blockedReason) {
    return (
      <p className="text-sm text-muted" data-attr="application-holding-fee-unavailable">
        {blockedReason}
      </p>
    );
  }

  if (paid) {
    return (
      <div data-attr="application-holding-fee-box">
        <p className="text-sm font-semibold text-emerald-700" data-attr="application-holding-fee-status">
          Paid · {existingLabel}
        </p>
        <p className="mt-1 text-sm text-muted">Handle any refund directly, per your lease terms.</p>
      </div>
    );
  }

  return (
    <div data-attr="application-holding-fee-box">
      {existingLabel ? (
        <p className="mb-2 text-xs font-semibold text-muted" data-attr="application-holding-fee-status">
          Awaiting payment · {existingLabel}
        </p>
      ) : null}
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
          className="w-full pl-7"
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          disabled={busy}
          data-attr="application-holding-fee-amount"
        />
      </div>
      <p className="mt-2 text-xs text-muted">Credited toward their security deposit at approval.</p>
    </div>
  );
}

/**
 * Validate a typed amount into the draft the notification preview needs.
 *
 * Pure so the modal can call it from its footer button without reaching into
 * the field component.
 */
export function buildHoldingFeeDraft(
  amountText: string,
  propertyId: string,
  existingLabel?: string,
): { ok: true; draft: HoldingFeeNoticeDraft } | { ok: false; error: string } {
  const amt = Number.parseFloat(amountText);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, error: "Enter a holding fee amount greater than $0." };
  }
  if (amt > 100_000) {
    return { ok: false, error: "That holding fee looks too large — check the amount." };
  }
  return {
    ok: true,
    draft: {
      amount: amt,
      amountLabel: formatHoldingFeeAmountLabel(Number(amt.toFixed(2))),
      propertyLabel: resolveHoldingFeePropertyLabel(propertyId, existingLabel),
    },
  };
}

/**
 * Step 1 of the holding fee: the amount, with its actions in the modal footer.
 *
 * Mounted fresh on every open (see the `key` below) so the amount field seeds
 * from the charge that exists RIGHT NOW. Seeding in an effect instead would
 * mean a render with the previous applicant's number still on screen.
 */
function HoldingFeeAmountModal({
  row,
  onClose,
  onChanged,
  onReview,
  busy,
}: {
  row: {
    id: string;
    email?: string | null;
    name?: string | null;
    residentUserId?: string | null;
    propertyId?: string | null;
    application?: { propertyId?: string | null } | null;
  };
  onClose: () => void;
  onChanged?: () => void;
  onReview: (draft: HoldingFeeNoticeDraft) => void;
  busy: boolean;
}) {
  const { showToast } = useAppUi();
  const propertyId = row.application?.propertyId?.trim() || row.propertyId?.trim() || "";
  const residentEmail = row.email ?? "";
  const residentName = row.name ?? "";
  const residentUserId = row.residentUserId ?? null;
  const existing =
    residentEmail && propertyId
      ? findHoldingDepositCharge(residentEmail, propertyId, residentUserId, row.id)
      : undefined;

  const [amount, setAmount] = useState(() =>
    existing ? existing.amountLabel.replace(/[^0-9.]/g, "") : "",
  );
  const [removeBusy, setRemoveBusy] = useState(false);

  const paid = existing?.status === "paid";
  const blockedReason = applicationHoldingFeeBlockedReason(residentEmail, propertyId);
  const controlsBusy = busy || removeBusy;

  const review = () => {
    if (isDemoModeActive()) {
      showToast("Holding fees are read-only in the demo.");
      return;
    }
    const built = buildHoldingFeeDraft(amount, propertyId, existing?.propertyLabel);
    if (!built.ok) {
      showToast(built.error);
      return;
    }
    onReview(built.draft);
  };

  const remove = () => {
    setRemoveBusy(true);
    try {
      const result = removeApplicantHoldingFee({
        residentEmail,
        propertyId,
        residentUserId,
        applicationId: row.id,
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
    <Modal
      open
      onClose={onClose}
      title="Holding fee"
      description={`Ask ${residentName.trim() || "this applicant"} to hold the home while you review.`}
      dense
      panelClassName="max-w-md"
      dataAttr="application-holding-fee-modal"
      footer={
        blockedReason || paid ? undefined : (
          <ModalFooter className="w-full justify-between gap-2">
            {existing ? (
              <Button
                type="button"
                variant="danger"
                className="h-9 min-h-0 shrink-0 px-4 text-[13px]"
                disabled={controlsBusy}
                onClick={() => remove()}
                data-attr="application-holding-fee-remove"
              >
                Remove
              </Button>
            ) : (
              <span aria-hidden className="shrink-0" />
            )}
            <Button
              type="button"
              variant="primary"
              className={PORTAL_BULK_BAR_BTN}
              disabled={controlsBusy || !amount.trim()}
              onClick={() => review()}
              data-attr="application-holding-fee-preview"
            >
              Preview & update
            </Button>
          </ModalFooter>
        )
      }
    >
      <ApplicationHoldingFeeBox
        amount={amount}
        onAmountChange={setAmount}
        existingLabel={existing?.amountLabel}
        paid={paid}
        blockedReason={blockedReason}
        busy={controlsBusy}
      />
    </Modal>
  );
}

/**
 * The holding fee as a top-right header action rather than a body card.
 *
 * Two-step write (Add payment / Tours pattern): amount modal →
 * `PortalNotificationPreviewModal` → save fee + optional notice.
 *
 * The amount step is mounted only while it is on screen and is keyed by row, so
 * it always seeds from the charge that exists now — reopening on another
 * applicant can never show the previous one's amount.
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
      {open && noticePreview === null ? (
        <HoldingFeeAmountModal
          key={row.id}
          row={row}
          onClose={handleClose}
          onChanged={onChanged}
          onReview={setNoticePreview}
          busy={noticeBusy}
        />
      ) : null}

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
        showWorkNumberHint={false}
        hideSendViaFooterNote
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
