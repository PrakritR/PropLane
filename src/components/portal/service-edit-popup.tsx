"use client";

import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  buildPropertyOptions,
  buildResidentOptions,
  residentMatchesProperty,
} from "@/components/portal/pro-add-service-modal";
import { Input, Textarea } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import { emptyRoomsForManagerService } from "@/lib/manager-add-service-where";
import { updateManagerWorkOrder } from "@/lib/manager-work-orders-storage";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import { updateServiceRequest, type ServiceRequest } from "@/lib/service-requests-storage";
import { isWorkOrderCostLockedByVendor } from "@/lib/work-order-cost-lock";

const PRIORITIES = ["Low", "Medium", "High", "Emergency"] as const;

export type ServiceEditTarget = { kind: "add-on"; request: ServiceRequest } | { kind: "maintenance"; row: DemoManagerWorkOrderRow };

/** Everything the popup edits, as the strings its fields hold. */
export type ServiceEditDraft = {
  title: string;
  details: string;
  propertyId: string;
  residentEmail: string;
  roomChoice: string;
  priority: string;
  /** Add-on: the service fee. */
  price: string;
  deposit: string;
  returnBy: string;
  /** Maintenance: the cost. */
  cost: string;
  /** `datetime-local` value; empty = no visit. */
  visit: string;
  preferredArrival: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDatetimeLocal(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromDatetimeLocal(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function visitLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function money(raw: string | undefined): string {
  return sanitizeMoneyInput((raw ?? "").replace(/^\$/, ""));
}

/** The draft a target opens with. */
export function serviceEditDraftFor(target: ServiceEditTarget): ServiceEditDraft {
  if (target.kind === "add-on") {
    const req = target.request;
    return {
      title: req.offerName ?? "",
      details: req.offerDescription ?? "",
      propertyId: req.propertyId ?? "",
      residentEmail: req.residentEmail ?? "",
      roomChoice: "",
      priority: "Medium",
      price: money(req.price),
      deposit: money(req.deposit),
      returnBy: req.returnByDate ?? "",
      cost: "",
      visit: toDatetimeLocal(req.proposedVisit?.iso),
      preferredArrival: "",
    };
  }
  const row = target.row;
  return {
    title: row.title ?? "",
    details: row.description ?? "",
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim() || "",
    residentEmail: row.residentEmail ?? "",
    roomChoice: row.assignedRoomChoice ?? "",
    priority: row.priority?.trim() || "Medium",
    price: "",
    deposit: "",
    returnBy: "",
    cost: row.cost && row.cost !== "—" ? row.cost : "",
    visit: toDatetimeLocal(row.scheduledAtIso),
    preferredArrival: row.preferredArrival ?? "",
  };
}

/** The fields an add-on save writes, through the existing `updateServiceRequest`. */
export function addOnEditUpdates(
  draft: ServiceEditDraft,
  ctx: { propertyId: string; residentName: string; hasDeposit: boolean },
): Partial<ServiceRequest> {
  const visitIso = fromDatetimeLocal(draft.visit);
  return {
    offerName: draft.title.trim(),
    offerDescription: draft.details.trim(),
    price: draft.price.trim(),
    deposit: draft.deposit.trim(),
    returnByDate: ctx.hasDeposit ? draft.returnBy : "",
    propertyId: ctx.propertyId,
    residentEmail: draft.residentEmail.trim().toLowerCase(),
    residentName: ctx.residentName,
    ...(visitIso ? { proposedVisit: { iso: visitIso, source: "availability" as const } } : {}),
  };
}

/** The maintenance row after a save: only what the popup edits changes. */
export function applyWorkOrderEdit(
  row: DemoManagerWorkOrderRow,
  draft: ServiceEditDraft,
  ctx: { propertyLabel: string; residentName: string; costLocked: boolean },
): DemoManagerWorkOrderRow {
  const visitIso = fromDatetimeLocal(draft.visit);
  const propertyChanged = draft.propertyId && draft.propertyId !== (row.assignedPropertyId?.trim() || row.propertyId?.trim() || "");
  return {
    ...row,
    title: draft.title.trim() || row.title,
    description: draft.details.trim(),
    priority: draft.priority.trim() || row.priority,
    ...(ctx.costLocked || !draft.cost.trim() ? {} : { cost: draft.cost.trim() }),
    ...(propertyChanged
      ? { propertyId: draft.propertyId, ...(row.assignedPropertyId ? { assignedPropertyId: draft.propertyId } : {}), propertyName: ctx.propertyLabel || row.propertyName }
      : {}),
    residentEmail: draft.residentEmail.trim().toLowerCase() || undefined,
    residentName: ctx.residentName || undefined,
    assignedRoomChoice: draft.roomChoice.trim() || undefined,
    preferredArrival: draft.preferredArrival.trim() || undefined,
    ...(visitIso ? { scheduledAtIso: visitIso, scheduled: visitLabel(visitIso) } : {}),
  };
}

/**
 * Edit a service in the standard popup (the New property shell: header, step rail, live panel flush right,
 * Back / Continue, Save on the last step): Service - Home - Price - Schedule. One popup for an add-on and a
 * maintenance service; it replaces the add-on's two-field Edit dialog and the old maintenance edit sheet,
 * and saves through the same writes they did (`updateServiceRequest`, `updateManagerWorkOrder`).
 */
export function ServiceEditPopup({
  open,
  target,
  managerUserId,
  onClose,
  onSaved,
}: {
  open: boolean;
  target: ServiceEditTarget | null;
  managerUserId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { showToast } = useAppUi();
  const [draft, setDraft] = useState<ServiceEditDraft | null>(null);
  const [initial, setInitial] = useState<ServiceEditDraft | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [tick, setTick] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const targetKey = target ? (target.kind === "add-on" ? `a:${target.request.id}` : `m:${target.row.id}`) : "";

  useEffect(() => {
    if (!open || !target) {
      setDraft(null);
      return;
    }
    const next = serviceEditDraftFor(target);
    setDraft(next);
    setInitial(next);
    setStepIdx(0);
    setStepError(null);
    void syncPropertyPipelineFromServer().then(() => setTick((t) => t + 1));
    void syncManagerApplicationsFromServer().then(() => setTick((t) => t + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey]);

  const propertyOptions = useMemo(() => {
    void tick;
    return buildPropertyOptions(managerUserId);
  }, [managerUserId, tick]);
  const residentOptions = useMemo(() => {
    void tick;
    return buildResidentOptions(managerUserId);
  }, [managerUserId, tick]);

  if (!open || !target || !draft || !initial) return null;
  const isAddOn = target.kind === "add-on";
  const set = (patch: Partial<ServiceEditDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  const property = propertyOptions.find((p) => p.propertyId === draft.propertyId) ?? null;
  const residents = property ? residentOptions.filter((r) => residentMatchesProperty(r, property)) : residentOptions;
  const currentResidentName = isAddOn ? target.request.residentName : target.row.residentName ?? "";
  const residentChoices = [
    { value: "", label: "None" },
    ...residents.map((r) => ({ value: r.residentEmail, label: r.roomLabel ? `${r.residentName} · ${r.roomLabel}` : r.residentName })),
  ];
  if (draft.residentEmail && !residentChoices.some((choice) => choice.value === draft.residentEmail.toLowerCase())) {
    residentChoices.push({ value: draft.residentEmail, label: currentResidentName || draft.residentEmail });
  }
  const pickedResident = residentOptions.find((r) => r.residentEmail === draft.residentEmail.toLowerCase());
  const residentName = pickedResident?.residentName ?? (draft.residentEmail.toLowerCase() === (isAddOn ? target.request.residentEmail : target.row.residentEmail ?? "").toLowerCase() ? currentResidentName : "");
  const roomOptions = !isAddOn && draft.propertyId ? emptyRoomsForManagerService(draft.propertyId, draft.roomChoice) : [];
  const costLocked = !isAddOn && isWorkOrderCostLockedByVendor(target.row);
  const hasDeposit = draft.deposit.trim() !== "" && draft.deposit.trim() !== "0";

  const steps: AddWorkspaceStep[] = [
    { id: "service", label: "Service", incomplete: !draft.title.trim() },
    { id: "home", label: "Home", incomplete: false },
    { id: "price", label: "Price", incomplete: false },
    { id: "schedule", label: "Schedule", incomplete: false },
  ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const propertyLabel = property?.propertyLabel ?? (isAddOn ? "" : target.row.propertyName);

  const save = () => {
    if (!draft.title.trim()) {
      setStepIdx(0);
      setStepError("Add a name for the service.");
      return;
    }
    if (isAddOn) {
      updateServiceRequest(target.request.id, addOnEditUpdates(draft, { propertyId: draft.propertyId, residentName, hasDeposit }));
      showToast("Service updated.");
    } else {
      updateManagerWorkOrder(target.row.id, (row) => applyWorkOrderEdit(row, draft, { propertyLabel: property?.propertyLabel ?? "", residentName, costLocked }));
      showToast("Service updated.");
    }
    onSaved?.();
    onClose();
  };

  const visitFact = fromDatetimeLocal(draft.visit);

  return (
    <AddWorkspace
      title="Edit service"
      steps={steps}
      current={current}
      onJump={(index) => {
        setStepError(null);
        setStepIdx(index);
      }}
      onClose={onClose}
      dirty={dirty}
      discardTitle="Discard your changes?"
      discardBody="Nothing has been saved yet. Close and lose what you changed?"
      assistantContext="Edit a service."
      assistantScopeKey="Edit service"
      sidePanel={
        <PreviewPanel
          title="Service"
          name={draft.title.trim() || "Service"}
          facts={[
            { label: "Property", value: propertyLabel || "—" },
            { label: "Resident", value: residentName || "—" },
            { label: isAddOn ? "Fee" : "Cost", value: (isAddOn ? draft.price : draft.cost) ? (isAddOn ? `$${draft.price}` : draft.cost) : "—" },
            { label: "Visit", value: visitFact ? visitLabel(visitFact) : "—" },
          ]}
          creates={[{ tone: "yes", text: "Saves to this service" }]}
          createsHeading="This will"
        />
      }
      lastLabel="Save changes"
      busy={false}
      onFinish={save}
      dataAttrPrefix="service-edit"
      finishDataAttr="service-edit-save"
      footerNote={stepError ? <span className="text-sm text-rose-600">{stepError}</span> : null}
    >
      {stepId === "service" ? (
        <StepColumn>
          <StepHeading title="Service" />
          <WizardField label="Name" required>
            <Input value={draft.title} onChange={(e) => set({ title: e.target.value })} className="bg-card" data-attr="service-edit-title" required />
          </WizardField>
          {!isAddOn ? (
            <WizardSelect
              label="Priority"
              value={draft.priority}
              onChange={(value) => set({ priority: value })}
              options={PRIORITIES.map((p) => ({ value: p, label: p }))}
              dataAttr="service-edit-priority"
            />
          ) : null}
          <WizardField label="Details">
            <Textarea value={draft.details} onChange={(e) => set({ details: e.target.value })} rows={4} className="bg-card" data-attr="service-edit-details" />
          </WizardField>
        </StepColumn>
      ) : null}
      {stepId === "home" ? (
        <StepColumn>
          <StepHeading title="Home" />
          <WizardSelect
            label="Property"
            value={draft.propertyId}
            onChange={(value) => set({ propertyId: value, residentEmail: "", roomChoice: "" })}
            options={propertyOptions.map((p) => ({ value: p.propertyId, label: p.propertyLabel }))}
            placeholder="Select property"
            dataAttr="service-edit-property"
          />
          {!isAddOn ? (
            <WizardSelect
              label="Room"
              value={draft.roomChoice}
              onChange={(value) => set({ roomChoice: value })}
              options={[{ value: "", label: "None" }, ...roomOptions]}
              placeholder={!draft.propertyId ? "Select property first" : roomOptions.length === 0 ? "No empty rooms" : "Optional"}
              disabled={!draft.propertyId}
              dataAttr="service-edit-room"
            />
          ) : null}
          <WizardSelect
            label="Resident"
            value={draft.residentEmail}
            onChange={(value) => {
              const picked = residentOptions.find((r) => r.residentEmail === value);
              set({ residentEmail: value, ...(!isAddOn && picked?.assignedRoomChoice && !draft.roomChoice ? { roomChoice: picked.assignedRoomChoice } : {}) });
            }}
            options={residentChoices}
            placeholder={!draft.propertyId ? "Select property first" : "Optional"}
            dataAttr="service-edit-resident"
          />
        </StepColumn>
      ) : null}
      {stepId === "price" ? (
        <StepColumn>
          <StepHeading title="Price" />
          {isAddOn ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <WizardField label="Service fee">
                  <Input value={draft.price} inputMode="decimal" placeholder="$0" onChange={(e) => set({ price: sanitizeMoneyInput(e.target.value) })} className="bg-card" data-attr="service-edit-price" />
                </WizardField>
                <WizardField label="Deposit">
                  <Input value={draft.deposit} inputMode="decimal" placeholder="$0" onChange={(e) => set({ deposit: sanitizeMoneyInput(e.target.value) })} className="bg-card" data-attr="service-edit-deposit" />
                </WizardField>
              </div>
              {hasDeposit ? (
                <WizardField label="Return by">
                  <Input type="date" value={draft.returnBy} onChange={(e) => set({ returnBy: e.target.value })} className="bg-card" data-attr="service-edit-return-by" />
                </WizardField>
              ) : null}
            </>
          ) : (
            <WizardField label="Cost">
              <Input
                value={draft.cost}
                placeholder="$0"
                disabled={costLocked}
                onChange={(e) => set({ cost: e.target.value })}
                className="bg-card"
                data-attr="service-edit-cost"
              />
            </WizardField>
          )}
        </StepColumn>
      ) : null}
      {stepId === "schedule" ? (
        <StepColumn>
          <StepHeading title="Schedule" />
          <WizardField label="Visit">
            <Input type="datetime-local" value={draft.visit} onChange={(e) => set({ visit: e.target.value })} className="bg-card" data-attr="service-edit-visit" />
          </WizardField>
          {!isAddOn ? (
            <WizardField label="Preferred arrival">
              <Input value={draft.preferredArrival} placeholder="Anytime" onChange={(e) => set({ preferredArrival: e.target.value })} className="bg-card" data-attr="service-edit-arrival" />
            </WizardField>
          ) : null}
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
