"use client";

import { useState } from "react";
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
 */
export function ApplicationHoldingFeeBox({
  applicationId,
  residentEmail,
  residentName,
  residentUserId,
  propertyId,
  managerUserId,
  onChanged,
  bare = false,
}: {
  applicationId: string;
  residentEmail: string;
  residentName: string;
  residentUserId: string | null;
  propertyId: string;
  managerUserId: string | null;
  onChanged?: () => void;
  /** Inside the modal the surrounding card and repeated title are noise. */
  bare?: boolean;
}) {
  const { showToast } = useAppUi();
  const existing = residentEmail && propertyId
    ? findHoldingDepositCharge(residentEmail, propertyId, residentUserId, applicationId)
    : undefined;
  const [amount, setAmount] = useState(() =>
    existing ? existing.amountLabel.replace(/[^0-9.]/g, "") : "",
  );
  const [busy, setBusy] = useState(false);

  const paid = existing?.status === "paid";
  const demo = isDemoModeActive();

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

  const save = async () => {
    if (demo) {
      showToast("Holding fees are read-only in the demo.");
      return;
    }
    setBusy(true);
    try {
      const previousAmount = existing?.amountLabel;
      const result = setApplicantHoldingFee({
        residentEmail,
        residentName,
        residentUserId,
        propertyId,
        applicationId,
        managerUserId,
        amount: Number.parseFloat(amount),
      });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      showToast(
        result.alreadyPaid
          ? "This holding fee is already paid — the amount was left unchanged."
          : `Holding fee of ${result.charge.amountLabel} added for ${result.charge.residentName}.`,
      );

      const shouldNotify =
        !result.alreadyPaid &&
        residentEmail.includes("@") &&
        result.charge.amountLabel !== previousAmount;
      if (shouldNotify) {
        const notice = await deliverPortalInboxMessage({
          eventCategory: "payments",
          toEmails: [residentEmail],
          subject: `Holding fee due: ${result.charge.amountLabel}`,
          text: buildHoldingFeeNoticeBody({
            residentName: residentName.trim() || "there",
            residentEmail,
            amountLabel: result.charge.amountLabel,
            propertyLabel: result.charge.propertyLabel,
          }),
        });
        if (!notice.ok && notice.error) {
          showToast(`Holding fee saved, but notice failed: ${notice.error}`);
        }
      }

      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
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
      setBusy(false);
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
        Optional. We notify the applicant and add it to their Payments tab right away. The same
        amount credits toward their security deposit when you approve — deposit and move-in fee
        charges are only billed at approval.
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
              disabled={busy}
              data-attr="application-holding-fee-amount"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-9 min-h-0 px-4 text-[13px]"
            disabled={busy || !amount.trim()}
            onClick={() => save()}
            data-attr="application-holding-fee-save"
          >
            {existing ? "Update holding fee" : "Add holding fee"}
          </Button>
          {existing ? (
            <Button
              type="button"
              variant="danger"
              className="h-9 min-h-0 px-4 text-[13px]"
              disabled={busy}
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
 * `key` on the box is deliberate: it seeds its amount field from the charge
 * that exists at mount, so without a per-application key the modal would show
 * the previous applicant's amount when reopened on another row.
 */
export function ApplicationHoldingFeeModal({
  row,
  open,
  onClose,
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
}) {
  if (!row) return null;
  const propertyId = row.application?.propertyId?.trim() || row.propertyId?.trim() || "";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Holding fee"
      description={`Ask ${row.name?.trim() || "this applicant"} to hold the home while you review.`}
      dataAttr="application-holding-fee-modal"
    >
      <ApplicationHoldingFeeBox
        bare
        key={row.id}
        applicationId={row.id}
        residentEmail={row.email ?? ""}
        residentName={row.name ?? ""}
        residentUserId={row.residentUserId ?? null}
        propertyId={propertyId}
        managerUserId={row.managerUserId ?? null}
      />
    </Modal>
  );
}
