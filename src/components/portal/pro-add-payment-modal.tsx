"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";
import { Button } from "@/components/ui/button";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField, WizardMultiSelect, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Input } from "@/components/ui/input";
import type { ManagerPaymentBucket } from "@/data/demo-portal";
import {
  EVERYONE_IN_HOUSE,
  chargesAddedMessage,
  createChargesForResidents,
  nextResidentSelection,
  pickerSelection,
  type BatchChargeResident,
} from "@/lib/manager-charge-batch";
import { MANAGER_PAYMENT_PRESETS, type ManagerPaymentPresetId } from "@/lib/payment-policy";
import { defaultDueIsoForReminderSettings } from "@/lib/payment-reminder-bootstrap";
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
  residents: BatchChargeResident[];
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
  initialResidentEmail,
  initialTitle,
  serviceRecordId,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  managerUserId: string | null;
  initialApplicationId?: string;
  initialPropertyId?: string;
  /** Prefill the resident by email (a service record's resident) when there is no application id to hand. */
  initialResidentEmail?: string;
  /** Prefill the charge title (the service's name). */
  initialTitle?: string;
  /** The service this charge is for: stamped on the charge so it lists under that service's Incoming payments. */
  serviceRecordId?: string;
}) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [applicationTick, setApplicationTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyId, setPropertyId] = useState("");
  const [residentApplicationIds, setResidentApplicationIds] = useState<string[]>([]);
  const [preset, setPreset] = useState<ManagerPaymentPresetId>("rent");
  const [chargeTitle, setChargeTitle] = useState("Monthly rent");
  const [amount, setAmount] = useState("");
  const [dueIso, setDueIso] = useState(() => defaultDueIsoForReminderSettings());
  const [bucket, setBucket] = useState<ManagerPaymentBucket>("pending");
  const [noticeBusy, setNoticeBusy] = useState(false);
  // Guards a double-submit: React's `noticeBusy` state update is batched, so two
  // clicks landing before the disabled prop re-renders could both pass a
  // state-only busy check. A ref updates synchronously, so the second call is
  // always rejected regardless of render timing.
  const submittingRef = useRef(false);
  // Minted once per modal open and again by `reset()` after every successful
  // submit (not once per render) so a retried submit reuses the SAME charge id —
  // the server upsert is `onConflict: "id"`, so a retry is idempotent instead of
  // creating a second charge — while a parent that keeps the modal open for a
  // second charge can never upsert it over the first.
  const chargeIdRef = useRef<string | null>(null);
  const mintChargeId = () => {
    chargeIdRef.current = `hc_mgr_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  };

  useEffect(() => {
    if (!open) return;
    mintChargeId();
  }, [open]);

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

  const selectedResidents = useMemo(
    () => residentOptions.filter((row) => residentApplicationIds.includes(row.applicationId)),
    [residentApplicationIds, residentOptions],
  );

  useEffect(() => {
    if (!open || !initialTitle?.trim()) return;
    setPreset("other");
    setChargeTitle(initialTitle.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || (!initialApplicationId && !initialPropertyId && !initialResidentEmail)) return;
    const email = initialResidentEmail?.trim().toLowerCase();
    const resident = initialApplicationId
      ? residentOptions.find((row) => row.applicationId === initialApplicationId)
      : email
        ? residentOptions.find((row) => row.residentEmail === email && (!initialPropertyId || row.propertyId === initialPropertyId)) ??
          residentOptions.find((row) => row.residentEmail === email)
        : null;
    if (resident) {
      setPropertyId(resident.propertyId);
      setResidentApplicationIds([resident.applicationId]);
      return;
    }
    if (initialPropertyId) setPropertyId(initialPropertyId);
  }, [open, initialApplicationId, initialPropertyId, initialResidentEmail, residentOptions]);

  const onPresetChange = (next: ManagerPaymentPresetId) => {
    setPreset(next);
    if (next === "other") return;
    const match = MANAGER_PAYMENT_PRESETS.find((p) => p.id === next);
    if (match) setChargeTitle(match.label);
  };

  const reset = () => {
    setPropertyId("");
    setResidentApplicationIds([]);
    setPreset("rent");
    setChargeTitle("Monthly rent");
    setAmount("");
    setDueIso(defaultDueIsoForReminderSettings());
    setBucket("pending");
    setNoticeBusy(false);
    setStepIdx(0);
    setStepError(null);
    mintChargeId();
  };

  // The x keeps an unfinished charge; only adding it (or Discard draft) forgets it.
  const workspaceDraft = useWorkspaceDraft({
    scope: `charge:${serviceRecordId ?? initialApplicationId ?? initialPropertyId ?? "new"}`,
    open,
    value: { stepIdx, propertyId, residentApplicationIds, preset, chargeTitle, amount, dueIso, bucket },
    restore: (saved) => {
      setStepIdx(saved.stepIdx);
      setPropertyId(saved.propertyId);
      // A draft saved before several residents could be picked kept one id under the old key.
      const legacy = (saved as { residentApplicationId?: string }).residentApplicationId;
      setResidentApplicationIds(saved.residentApplicationIds ?? (legacy ? [legacy] : []));
      setPreset(saved.preset);
      setChargeTitle(saved.chargeTitle);
      setAmount(saved.amount);
      setDueIso(saved.dueIso);
      setBucket(saved.bucket);
    },
  });

  const handleClose = () => {
    workspaceDraft.preserve();
    reset();
    onClose();
  };

  const buildPreview = (): PaymentPreview | null => {
    const amountNum = Number.parseFloat(amount);
    if (selectedResidents.length === 0) {
      showToast("Select a property and at least one resident.");
      return null;
    }
    if (!chargeTitle.trim() || !Number.isFinite(amountNum) || amountNum <= 0) {
      showToast("Enter a charge title and a positive amount.");
      return null;
    }

    const residents = selectedResidents.map((resident): BatchChargeResident => {
      // roomLabel often already carries its own prefix ("Unit 12A", "Room 3"),
      // so prefixing unconditionally produced "Unit Unit 12A" on the charge and
      // everywhere it is echoed (resident dashboard, payments, receipts).
      const roomLabel = resident.roomLabel.trim();
      const roomSuffix = /^(unit|room|apt|apartment|suite)\b/i.test(roomLabel) ? roomLabel : `Unit ${roomLabel}`;
      return {
        applicationId: resident.applicationId,
        residentName: resident.residentName,
        residentEmail: resident.residentEmail,
        propertyId: selectedProperty?.propertyId || resident.propertyId,
        propertyLabel: resident.propertyLabel,
        title: roomLabel ? `${chargeTitle.trim()} — ${roomSuffix}` : chargeTitle.trim(),
      };
    });
    return { residents, amount: amountNum, dueDateLabel: dueLabelFromIso(dueIso), bucket };
  };

  // Adding the charge IS the notice: each persisted row fires `charge_created` on the server (inbox card, SMS with that
  // charge's pay link, email), through the resident's own channel rules. This flow never sends a second one.
  const submitCharges = async () => {
    if (submittingRef.current) return;
    const preview = buildPreview();
    if (!preview) return;
    submittingRef.current = true;
    setNoticeBusy(true);
    try {
      const { created, failed } = createChargesForResidents(preview.residents, {
        managerUserId,
        amount: preview.amount,
        dueDateLabel: preview.dueDateLabel,
        initialStatus: preview.bucket === "paid" ? "paid" : "pending",
        workOrderId: serviceRecordId,
        baseId: chargeIdRef.current ?? `hc_mgr_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      });
      if (created.length === 0) {
        showToast("Could not add charge. Check all fields.");
        return;
      }

      if (preview.bucket !== "paid") {
        await Promise.all(created.map((charge) => restoreFutureRemindersForPendingCharge(charge.id).catch(() => undefined)));
      }

      workspaceDraft.clear();
      reset();
      onSubmitted();
      showToast(
        failed.length > 0
          ? `${chargesAddedMessage(created.length)} ${failed.length} could not be added.`
          : chargesAddedMessage(created.length),
      );
    } finally {
      submittingRef.current = false;
      setNoticeBusy(false);
    }
  };

  const noProperties = propertyOptions.length === 0;
  const amountNum = Number.parseFloat(amount);
  const whoIncomplete = !propertyId || residentApplicationIds.length === 0;
  const amountIncomplete = !chargeTitle.trim() || !Number.isFinite(amountNum) || amountNum <= 0;
  const presetLabel = MANAGER_PAYMENT_PRESETS.find((option) => option.id === preset)?.label ?? "Charge";
  const residentLabel =
    selectedResidents.length === 0
      ? "Not set"
      : selectedResidents.length === 1
        ? selectedResidents[0]!.residentName
        : `${selectedResidents.length} residents`;
  const amountLabel = Number.isFinite(amountNum) && amountNum > 0 ? `$${amountNum.toFixed(2)}` : "Not set";
  const residentsFactLabel = selectedResidents.length > 1 ? "Residents" : "Resident";
  const steps: AddWorkspaceStep[] = [
    { id: "who", label: "Who", incomplete: whoIncomplete },
    { id: "amount", label: "Amount", incomplete: amountIncomplete },
    { id: "review", label: "Review" },
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
          keepsDraft
          onDiscardDraft={workspaceDraft.clear}
          dirty={Boolean(propertyId || residentApplicationIds.length > 0 || amount.trim())}
          discardTitle="Discard this charge?"
          assistantContext="Add a resident charge on Incoming."
          assistantScopeKey="Add charge"
          sidePanel={
            <PreviewPanel
              title="Charge"
              name={residentLabel}
              facts={[
                { label: residentsFactLabel, value: residentLabel, warn: residentApplicationIds.length === 0 },
                { label: "Type", value: presetLabel },
                { label: "Amount", value: amountLabel, warn: amountIncomplete },
              ]}
            />
          }
          lastLabel={selectedResidents.length > 1 ? `Add ${selectedResidents.length} charges` : "Add charge"}
          busy={noticeBusy}
          nextDisabled={(stepId === "who" && whoIncomplete) || (stepId === "amount" && amountIncomplete)}
          onBeforeNext={() => {
            if (stepId === "who" && whoIncomplete) {
              setStepError(noProperties ? "Add a property first." : "Select a property and at least one resident.");
              return false;
            }
            if (stepId === "amount" && amountIncomplete) {
              setStepError("Enter a charge title and a positive amount.");
              return false;
            }
            setStepError(null);
            return true;
          }}
          onFinish={() => void submitCharges()}
          dataAttrPrefix="payments-add"
          finishDataAttr="payments-empty-add"
          footerNote={stepError ? <span className="text-sm text-rose-600">{stepError}</span> : null}
        >
          {stepId === "who" ? (
            <StepColumn>
              <StepHeading title="Property and residents" />
              {noProperties ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-4 py-8">
                  <p className="text-[16px] font-bold">No properties</p>
                  <Button type="button" onClick={() => router.push("/portal/properties")}>Add property</Button>
                </div>
              ) : (
                <div className="sm:space-y-4">
                  <WizardSelect
                    label="Property"
                    value={propertyId}
                    onChange={(next) => {
                      setPropertyId(next);
                      setResidentApplicationIds([]);
                    }}
                    options={propertyOptions.map((option) => ({ value: option.propertyId, label: option.propertyLabel }))}
                    placeholder="Select property"
                  />
                  <WizardMultiSelect
                    label="Residents"
                    required
                    options={[
                      ...(residentsForProperty.length > 1 ? [{ value: EVERYONE_IN_HOUSE, label: "Everyone in this house" }] : []),
                      ...residentsForProperty.map((row) => ({ value: row.applicationId, label: row.residentName })),
                    ]}
                    selected={pickerSelection(residentApplicationIds, residentsForProperty.map((row) => row.applicationId))}
                    onChange={(next) =>
                      setResidentApplicationIds(
                        nextResidentSelection(
                          pickerSelection(residentApplicationIds, residentsForProperty.map((row) => row.applicationId)),
                          next,
                          residentsForProperty.map((row) => row.applicationId),
                        ),
                      )
                    }
                    emptyLabel={!propertyId ? "Select property first" : residentsForProperty.length === 0 ? "No residents at this property" : "Select residents"}
                    emptyMenuText="No residents at this property"
                    disabled={!propertyId}
                    dataAttr="payments-add-residents"
                  />
                </div>
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
                  { label: residentsFactLabel, value: residentLabel },
                  { label: "Type", value: presetLabel },
                  { label: selectedResidents.length > 1 ? "Amount each" : "Amount", value: amountLabel },
                ]}
              />
            </StepColumn>
          ) : null}
        </AddWorkspace>
      ) : null}
    </>
  );
}
