"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Input } from "@/components/ui/input";
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
import {
  applicationVisibleToPortalUser,
  buildManagerPropertyFilterOptions,
} from "@/lib/manager-portfolio-access";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import { PROPERTY_PIPELINE_EVENT, syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";

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
  const router = useRouter();
  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
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
    window.addEventListener(WORKSPACE_SELECTION_EVENT, onProperties);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApplications);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProperties);
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, onProperties);
    };
  }, [open, managerUserId]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyFilterOptions(managerUserId)
      .map((option) => ({
        propertyId: option.id,
        propertyLabel: displayPropertyLabel(option.label) || option.label,
      }))
      .filter((option) => option.propertyLabel);
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
    setStepIdx(0);
    setStepError(null);
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
  const amountNum = Number.parseFloat(amount);
  const whoIncomplete = !propertyId || !residentApplicationId;
  const amountIncomplete = !chargeTitle.trim() || !Number.isFinite(amountNum) || amountNum <= 0;
  const presetLabel = MANAGER_PAYMENT_PRESETS.find((option) => option.id === preset)?.label ?? "Charge";
  const propertyLabel = selectedProperty?.propertyLabel ?? "Not set";
  const residentLabel = selectedResident?.residentName ?? "Not set";
  const amountLabel = Number.isFinite(amountNum) && amountNum > 0 ? `$${amountNum.toFixed(2)}` : "Not set";
  const steps: AddWorkspaceStep[] = [
    { id: "who", label: "Who", summary: whoIncomplete ? "Property and resident" : `${residentLabel} · ${propertyLabel}`, incomplete: whoIncomplete },
    { id: "amount", label: "Amount", summary: amountIncomplete ? "Amount" : `${presetLabel} · ${amountLabel}`, incomplete: amountIncomplete },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  return (
    <>
      {open ? (
        <AddWorkspace
          title="Add charge"
          steps={steps}
          current={current}
          onJump={(index) => {
            setStepError(null);
            setStepIdx(index);
          }}
          onClose={handleClose}
          onRequestClose={() => {
            if (noticePreview) {
              setNoticePreview(null);
              return false;
            }
            return true;
          }}
          dirty={Boolean(propertyId || residentApplicationId || amount.trim())}
          discardTitle="Discard this charge?"
          assistantContext="Add a resident charge on Incoming."
          assistantScopeKey="Add charge"
          overlay={
            noticePreview ? (
              <PortalNotificationPreviewModal
                open
                title="New payment — notification preview"
                onClose={() => setNoticePreview(null)}
                recipient={noticePreview.residentEmail}
                subject={`New charge: ${noticePreview.chargeTitle}`}
                body={previewBody ?? ""}
                showChannelPicker
                emailAvailable={Boolean(noticePreview.residentEmail?.includes("@"))}
                smsAvailable
                deliverViaKind="payments"
                hideSendViaFooterNote
                confirmLabel="Add payment & send notice"
                confirmLabelWithoutMessage="Add payment only"
                confirmBusy={noticeBusy}
                confirmBusyLabel="Adding…"
                cancelLabel="Back"
                onConfirm={(skipMessage, channels, draft) => void confirmPayment(skipMessage, channels, draft)}
              />
            ) : null
          }
          sidePanel={
            <PreviewPanel
              title="Charge"
              name={residentLabel}
              facts={[
                { label: "Resident", value: residentLabel, warn: !residentApplicationId },
                { label: "Type", value: presetLabel },
                { label: "Amount", value: amountLabel, warn: amountIncomplete },
              ]}
              creates={[
                { tone: "yes", text: "Pending charge on Incoming" },
                { tone: "no", text: "Reminder uses your payment settings" },
              ]}
            />
          }
          lastLabel="Add charge"
          nextDisabled={(stepId === "who" && whoIncomplete) || (stepId === "amount" && amountIncomplete)}
          onBeforeNext={() => {
            if (stepId === "who" && whoIncomplete) {
              setStepError(noProperties ? "Add a property first." : "Select a property and resident.");
              return false;
            }
            if (stepId === "amount" && amountIncomplete) {
              setStepError("Enter a charge title and a positive amount.");
              return false;
            }
            setStepError(null);
            return true;
          }}
          onFinish={reviewPayment}
          dataAttrPrefix="payments-add"
          finishDataAttr="payments-empty-add"
          footerNote={stepError ? <span className="text-sm text-rose-600">{stepError}</span> : null}
        >
          {stepId === "who" ? (
            <StepColumn>
              <StepHeading title="Property and resident" />
              {noProperties ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-4 py-8">
                  <p className="text-[16px] font-bold">No properties</p>
                  <Button type="button" onClick={() => router.push("/portal/properties")}>Add property</Button>
                </div>
              ) : (
                <>
                  <WizardSelect
                    label="Property"
                    value={propertyId}
                    onChange={(next) => {
                      setPropertyId(next);
                      setResidentApplicationId("");
                    }}
                    options={propertyOptions.map((option) => ({ value: option.propertyId, label: option.propertyLabel }))}
                    placeholder="Select property"
                  />
                  <WizardSelect
                    label="Resident"
                    value={residentApplicationId}
                    onChange={setResidentApplicationId}
                    options={residentsForProperty.map((row) => ({ value: row.applicationId, label: row.residentName }))}
                    placeholder={!propertyId ? "Select property first" : residentsForProperty.length === 0 ? "No residents at this property" : "Select resident"}
                    disabled={!propertyId}
                  />
                </>
              )}
            </StepColumn>
          ) : null}
          {stepId === "amount" ? (
            <StepColumn>
              <StepHeading title="Amount" />
              <WizardSelect
                label="Type"
                value={preset}
                onChange={(next) => onPresetChange(next as ManagerPaymentPresetId)}
                options={MANAGER_PAYMENT_PRESETS.map((option) => ({ value: option.id, label: option.label }))}
              />
              <WizardField label="Charge title" required>
                <Input value={chargeTitle} onChange={(e) => setChargeTitle(e.target.value)} placeholder="April rent" autoComplete="off" />
              </WizardField>
              <WizardField label="Amount" required>
                <Input type="number" inputMode="decimal" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1100" />
              </WizardField>
              <WizardField label="Due">
                <Input type="date" value={dueIso} onChange={(e) => setDueIso(e.target.value)} />
              </WizardField>
              <WizardSelect
                label="Status"
                value={bucket}
                onChange={(next) => setBucket(next as ManagerPaymentBucket)}
                options={[
                  { value: "pending", label: "Pending" },
                  { value: "overdue", label: "Overdue" },
                  { value: "paid", label: "Paid" },
                ]}
              />
            </StepColumn>
          ) : null}
          {stepId === "review" ? (
            <StepColumn>
              <StepHeading title="Review" />
              <PreviewPanel
                title="Charge"
                name={residentLabel}
                facts={[
                  { label: "Resident", value: residentLabel },
                  { label: "Type", value: presetLabel },
                  { label: "Amount", value: amountLabel },
                ]}
                creates={[{ tone: "yes", text: "Creates a charge on Incoming" }]}
              />
            </StepColumn>
          ) : null}
        </AddWorkspace>
      ) : null}
    </>
  );
}
