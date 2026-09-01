"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, MODAL_FIELD_LABEL_CLASS, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Input, Select } from "@/components/ui/input";
import type { ManagerPaymentBucket } from "@/data/demo-portal";
import { createManagerCharge } from "@/lib/household-charges";
import { MANAGER_PAYMENT_PRESETS, type ManagerPaymentPresetId } from "@/lib/payment-policy";
import { defaultDueIsoForReminderSettings } from "@/lib/payment-reminder-bootstrap";
import { buildNewChargeNoticeBody, deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { restoreFutureRemindersForPendingCharge } from "@/components/portal/payment-schedule-ui";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";

function dueLabelFromIso(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Property name only — strips " · 9 rooms", unit labels, and legacy id suffixes. */
function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

type PropertyPaymentOption = {
  propertyId: string;
  propertyLabel: string;
};

function buildManagerPropertyOptions(managerUserId: string | null): PropertyPaymentOption[] {
  if (!managerUserId) return [];
  const seen = new Map<string, PropertyPaymentOption>();

  for (const property of readExtraListingsForUser(managerUserId)) {
    const propertyId = property.id.trim();
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel(property.buildingName.trim() || property.title);
    if (!propertyLabel) continue;
    seen.set(propertyId, { propertyId, propertyLabel });
  }

  for (const property of readPendingManagerPropertiesForUser(managerUserId)) {
    const propertyId = property.id.trim();
    if (!propertyId || seen.has(propertyId)) continue;
    const propertyLabel = displayPropertyLabel(property.buildingName.trim());
    if (!propertyLabel) continue;
    seen.set(propertyId, { propertyId, propertyLabel });
  }

  return [...seen.values()].sort((a, b) =>
    a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" }),
  );
}

type ResidentPaymentOption = {
  applicationId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
};

function residentBelongsToProperty(resident: ResidentPaymentOption, property: PropertyPaymentOption): boolean {
  if (resident.propertyId && resident.propertyId === property.propertyId) return true;
  return resident.propertyLabel.toLowerCase() === property.propertyLabel.toLowerCase();
}

function buildResidentPaymentOptions(managerUserId: string | null): ResidentPaymentOption[] {
  return readManagerApplicationRows()
    .filter(
      (row) =>
        isCurrentResidentApplicationRow(row) &&
        applicationVisibleToPortalUser(row, managerUserId) &&
        row.name?.trim() &&
        row.email?.trim().includes("@"),
    )
    .map((row) => {
      const propertyLabel = displayPropertyLabel(row.property?.trim() || "");
      const propertyId =
        row.assignedPropertyId?.trim() ||
        row.propertyId?.trim() ||
        (propertyLabel
          ? `prop_mgr_${propertyLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
          : "");
      const roomLabel =
        getRoomChoiceLabel(row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "")
          .split(" · ")[0]
          ?.trim() ||
        row.manualResidentDetails?.roomNumber?.trim() ||
        "";
      return {
        applicationId: row.id,
        residentName: row.name.trim(),
        residentEmail: row.email!.trim().toLowerCase(),
        propertyId,
        propertyLabel: propertyLabel || "Property",
        roomLabel,
      };
    })
    .sort((a, b) => {
      const byProperty = a.propertyLabel.localeCompare(b.propertyLabel, undefined, { sensitivity: "base" });
      if (byProperty !== 0) return byProperty;
      return a.residentName.localeCompare(b.residentName, undefined, { sensitivity: "base" });
    });
}

type PaymentPreview = {
  propertyName: string;
  propertyId: string;
  applicationId?: string;
  residentName: string;
  residentEmail: string;
  chargeTitle: string;
  amount: number;
  dueDateLabel: string;
  bucket: ManagerPaymentBucket;
};

export function ManagerAddPaymentModal({
  open,
  onClose,
  onSubmitted,
  managerUserId,
  initialApplicationId,
  initialPropertyId,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  managerUserId: string | null;
  initialApplicationId?: string;
  initialPropertyId?: string;
}) {
  const { showToast } = useAppUi();
  const [applicationTick, setApplicationTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyId, setPropertyId] = useState("");
  const [residentApplicationId, setResidentApplicationId] = useState("");
  const [preset, setPreset] = useState<ManagerPaymentPresetId>("rent");
  const [chargeTitle, setChargeTitle] = useState("Monthly rent");
  const [amount, setAmount] = useState("");
  const [dueIso, setDueIso] = useState(() => defaultDueIsoForReminderSettings());
  const [bucket, setBucket] = useState<ManagerPaymentBucket>("pending");
  const [noticePreview, setNoticePreview] = useState<PaymentPreview | null>(null);
  const [noticeBusy, setNoticeBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onApplications = () => setApplicationTick((n) => n + 1);
    const onProperties = () => setPropertyTick((n) => n + 1);
    void syncManagerApplicationsFromServer({ force: true, managerUserId: managerUserId ?? undefined }).then(onApplications);
    void syncPropertyPipelineFromServer({ force: true }).then(onProperties);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
    };
  }, [open, managerUserId]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyOptions(managerUserId);
  }, [managerUserId, propertyTick]);

  const residentOptions = useMemo(() => {
    void applicationTick;
    return buildResidentPaymentOptions(managerUserId);
  }, [applicationTick, managerUserId]);

  const selectedProperty = useMemo(
    () => propertyOptions.find((row) => row.propertyId === propertyId) ?? null,
    [propertyId, propertyOptions],
  );

  const residentsForProperty = useMemo(() => {
    if (!selectedProperty) return [];
    return residentOptions.filter((row) => residentBelongsToProperty(row, selectedProperty));
  }, [residentOptions, selectedProperty]);

  const selectedResident = useMemo(
    () => residentOptions.find((row) => row.applicationId === residentApplicationId) ?? null,
    [residentApplicationId, residentOptions],
  );

  useEffect(() => {
    if (!open || (!initialApplicationId && !initialPropertyId)) return;
    const resident = initialApplicationId
      ? residentOptions.find((row) => row.applicationId === initialApplicationId)
      : null;
    if (resident) {
      setPropertyId(resident.propertyId);
      setResidentApplicationId(resident.applicationId);
      return;
    }
    if (initialPropertyId) setPropertyId(initialPropertyId);
  }, [open, initialApplicationId, initialPropertyId, residentOptions]);

  const onPresetChange = (next: ManagerPaymentPresetId) => {
    setPreset(next);
    if (next === "other") return;
    const match = MANAGER_PAYMENT_PRESETS.find((p) => p.id === next);
    if (match) setChargeTitle(match.label);
  };

  const reset = () => {
    setPropertyId("");
    setResidentApplicationId("");
    setPreset("rent");
    setChargeTitle("Monthly rent");
    setAmount("");
    setDueIso(defaultDueIsoForReminderSettings());
    setBucket("pending");
    setNoticePreview(null);
    setNoticeBusy(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const buildPreview = (): PaymentPreview | null => {
    const amountNum = Number.parseFloat(amount);
    if (!selectedResident) {
      showToast("Select a property and resident.");
      return null;
    }
    if (!chargeTitle.trim() || !Number.isFinite(amountNum) || amountNum <= 0) {
      showToast("Enter a charge title and a positive amount.");
      return null;
    }

    // roomLabel often already carries its own prefix ("Unit 12A", "Room 3"),
    // so prefixing unconditionally produced "Unit Unit 12A" on the charge and
    // everywhere it is echoed (resident dashboard, payments, receipts).
    const roomLabel = selectedResident.roomLabel.trim();
    const roomSuffix = /^(unit|room|apt|apartment|suite)\b/i.test(roomLabel) ? roomLabel : `Unit ${roomLabel}`;
    const titleWithRoom = roomLabel ? `${chargeTitle.trim()} — ${roomSuffix}` : chargeTitle.trim();

    return {
      propertyName: selectedResident.propertyLabel,
      propertyId: selectedProperty?.propertyId || selectedResident.propertyId,
      applicationId: selectedResident.applicationId,
      residentName: selectedResident.residentName,
      residentEmail: selectedResident.residentEmail,
      chargeTitle: titleWithRoom,
      amount: amountNum,
      dueDateLabel: dueLabelFromIso(dueIso),
      bucket,
    };
  };

  const reviewPayment = () => {
    const preview = buildPreview();
    if (!preview) return;
    setNoticePreview(preview);
  };

  const confirmPayment = async (
    skipMessage: boolean,
    channels?: { viaEmail: boolean; viaSms: boolean },
    draft?: { subject: string; body: string },
  ) => {
    if (!noticePreview || noticeBusy) return;
    setNoticeBusy(true);
    try {
      const result = createManagerCharge({
        residentEmail: noticePreview.residentEmail,
        residentName: noticePreview.residentName,
        propertyId: noticePreview.propertyId,
        propertyLabel: noticePreview.propertyName,
        managerUserId,
        applicationId: noticePreview.applicationId,
        title: noticePreview.chargeTitle,
        amount: noticePreview.amount,
        dueDateLabel: noticePreview.dueDateLabel,
        initialStatus: noticePreview.bucket === "paid" ? "paid" : "pending",
      });
      if (!result) {
        showToast("Could not add charge. Check all fields.");
        return;
      }

      if (noticePreview.bucket !== "paid") {
        await restoreFutureRemindersForPendingCharge(result.id).catch(() => undefined);
      }

      reset();
      onSubmitted();
      if (skipMessage) {
        showToast("Payment added (no notification sent).");
        return;
      }

      const amountLabel = `$${noticePreview.amount.toFixed(2)}`;
      const subject = draft?.subject?.trim() || `New charge: ${noticePreview.chargeTitle}`;
      const body =
        draft?.body?.trim() ||
        buildNewChargeNoticeBody({
          residentName: noticePreview.residentName,
          residentEmail: noticePreview.residentEmail,
          chargeTitle: noticePreview.chargeTitle,
          amountLabel,
          dueDateLabel: noticePreview.dueDateLabel,
          propertyLabel: noticePreview.propertyName,
        });
      const notice = await deliverPortalInboxMessage({
        eventCategory: "payments",
        toEmails: [noticePreview.residentEmail],
        subject,
        text: body,
        deliverViaEmail: channels?.viaEmail !== false,
        deliverViaSms: channels?.viaSms !== false,
      });

      if (notice.ok) {
        showToast(
          notice.skipped
            ? "Payment added. Notice sent (sandbox email skipped; SMS/inbox when available)."
            : "Payment added and notice sent via inbox, email, and SMS when available.",
        );
      } else {
        showToast(notice.error ? `Payment added, but notice failed: ${notice.error}` : "Payment added, but notice could not be sent.");
      }
    } finally {
      setNoticeBusy(false);
      setNoticePreview(null);
    }
  };

  const previewBody =
    noticePreview &&
    buildNewChargeNoticeBody({
      residentName: noticePreview.residentName,
      residentEmail: noticePreview.residentEmail,
      chargeTitle: noticePreview.chargeTitle,
      amountLabel: `$${noticePreview.amount.toFixed(2)}`,
      dueDateLabel: noticePreview.dueDateLabel,
      propertyLabel: noticePreview.propertyName,
    });

  const noProperties = propertyOptions.length === 0;
  const compactField = "min-h-9 rounded-xl px-3 py-1.5 text-sm";

  return (
    <>
      <Modal
        open={open && noticePreview === null}
        title="Add payment"
        onClose={handleClose}
        dense
        panelClassName="max-w-xl p-3 sm:p-4"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="h-9 rounded-full px-4 text-sm"
              onClick={reviewPayment}
              disabled={!propertyId}
            >
              Review & add payment
            </Button>
          </ModalFooter>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-0.5 sm:col-span-2">
            <span className={MODAL_FIELD_LABEL_CLASS}>Payment type</span>
            <Select value={preset} className={compactField} onChange={(e) => onPresetChange(e.target.value as ManagerPaymentPresetId)}>
              {MANAGER_PAYMENT_PRESETS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={MODAL_FIELD_LABEL_CLASS}>Property</span>
            <Select
              className={compactField}
              value={propertyId}
              onChange={(e) => {
                setPropertyId(e.target.value);
                setResidentApplicationId("");
              }}
              disabled={noProperties}
            >
              <option value="">{noProperties ? "No properties in portfolio" : "Select property"}</option>
              {propertyOptions.map((option) => (
                <option key={option.propertyId} value={option.propertyId}>
                  {option.propertyLabel}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={MODAL_FIELD_LABEL_CLASS}>Resident</span>
            <Select
              className={compactField}
              value={residentApplicationId}
              onChange={(e) => setResidentApplicationId(e.target.value)}
              disabled={!propertyId || residentsForProperty.length === 0}
            >
              <option value="">
                {!propertyId
                  ? "Select property first"
                  : residentsForProperty.length === 0
                    ? "No residents at this property"
                    : "Select resident"}
              </option>
              {residentsForProperty.map((row) => (
                <option key={row.applicationId} value={row.applicationId}>
                  {row.residentName}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={MODAL_FIELD_LABEL_CLASS}>Charge title</span>
            <Input
              className={compactField}
              value={chargeTitle}
              onChange={(e) => setChargeTitle(e.target.value)}
              placeholder="April rent"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={MODAL_FIELD_LABEL_CLASS}>Amount (USD)</span>
            <Input
              className={compactField}
              type="number"
              inputMode="decimal"
              min={0.01}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1850"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={MODAL_FIELD_LABEL_CLASS}>Due date</span>
            <Input className={compactField} type="date" value={dueIso} onChange={(e) => setDueIso(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={MODAL_FIELD_LABEL_CLASS}>Status</span>
            <Select className={compactField} value={bucket} onChange={(e) => setBucket(e.target.value as ManagerPaymentBucket)}>
              <option value="pending">Pending</option>
              <option value="overdue">Overdue</option>
              <option value="paid">Paid</option>
            </Select>
          </label>
        </div>
      </Modal>

      <PortalNotificationPreviewModal
        open={noticePreview !== null}
        title="New payment — notification preview"
        onClose={() => setNoticePreview(null)}
        recipient={noticePreview?.residentEmail ?? ""}
        subject={noticePreview ? `New charge: ${noticePreview.chargeTitle}` : ""}
        body={previewBody ?? ""}
        showChannelPicker
        emailAvailable={Boolean(noticePreview?.residentEmail?.includes("@"))}
        smsAvailable
        confirmLabel="Add payment & send notice"
        confirmLabelWithoutMessage="Add payment only"
        confirmBusy={noticeBusy}
        confirmBusyLabel="Adding…"
        cancelLabel="Back"
        onConfirm={(skipMessage, channels, draft) => void confirmPayment(skipMessage, channels, draft)}
      />
    </>
  );
}
