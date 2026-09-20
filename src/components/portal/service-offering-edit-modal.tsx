"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { useConfirm } from "@/components/providers/app-ui-provider";
import {
  createManagerListingServiceOption,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";

export function ServiceOfferingFields({
  row,
  onPatch,
  parts = "all",
}: {
  row: ManagerListingServiceOption;
  onPatch: (patch: Partial<ManagerListingServiceOption>) => void;
  parts?: "details" | "price" | "all";
}) {
  const details = parts === "details" || parts === "all";
  const price = parts === "price" || parts === "all";
  return (
    <>
      {details ? (
        <>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border text-primary"
              checked={row.available}
              onChange={(e) => onPatch({ available: e.target.checked })}
            />
            <span className="text-sm font-medium text-foreground">Available to residents</span>
          </label>
          <WizardField label="Name">
            <Input
              value={row.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              placeholder="e.g. Parking spot"
            />
          </WizardField>
          <WizardField label="Description">
            <Input
              value={row.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              placeholder="What the resident gets"
            />
          </WizardField>
        </>
      ) : null}
      {price ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <WizardField label="Price">
            <Input
              value={row.price}
              onChange={(e) => onPatch({ price: e.target.value })}
              placeholder="e.g. $25/mo"
            />
          </WizardField>
          <WizardField label="Deposit">
            <Input
              value={row.deposit}
              onChange={(e) => onPatch({ deposit: e.target.value })}
              placeholder="e.g. $100"
            />
          </WizardField>
        </div>
      ) : null}
    </>
  );
}

function normalizeOffering(row: ManagerListingServiceOption): ManagerListingServiceOption {
  return {
    ...row,
    name: row.name.trim(),
    description: row.description.trim(),
    price: row.price.trim(),
    deposit: row.deposit.trim(),
  };
}

/** Edit a single service offering — saves listing submission on Save. */
export function ServiceOfferingEditModal({
  open,
  offering,
  isNew = false,
  sub,
  saveTarget,
  managerUserId,
  onClose,
  onSaved,
  showToast,
  entityLabel = "service",
}: {
  open: boolean;
  offering: ManagerListingServiceOption | null;
  isNew?: boolean;
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  onClose: () => void;
  onSaved: () => void;
  showToast: (m: string) => void;
  entityLabel?: string;
}) {
  const [draft, setDraft] = useState<ManagerListingServiceOption>(() =>
    offering ? { ...offering } : createManagerListingServiceOption(),
  );
  const [error, setError] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    setDraft(offering ? { ...offering } : createManagerListingServiceOption());
    setError(null);
    setStepIdx(0);
  }, [open, offering]);

  const patch = (patchRow: Partial<ManagerListingServiceOption>) =>
    setDraft((prev) => ({ ...prev, ...patchRow }));

  const save = () => {
    const normalized = normalizeOffering(draft);
    if (!normalized.name) {
      setError(`${entityLabel.charAt(0).toUpperCase()}${entityLabel.slice(1)} name is required.`);
      return;
    }

    const offers = sub.serviceRequestOptions ?? [];
    const nextOffers = isNew
      ? [normalized, ...offers]
      : offers.map((o) => (o.id === normalized.id ? normalized : o));

    const next: ManagerListingSubmissionV1 = { ...sub, serviceRequestOptions: nextOffers };
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast(`Could not save ${entityLabel}.`);
      return;
    }
    const label = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);
    showToast(isNew ? `${label} added.` : `${label} saved.`);
    onClose();
    onSaved();
  };

  const confirm = useConfirm();

  const remove = async () => {
    if (isNew || !offering) return;
    const label = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);
    if (!(await confirm({ description: `Delete this ${entityLabel}?` }))) return;
    const nextOffers = (sub.serviceRequestOptions ?? []).filter((o) => o.id !== offering.id);
    const next: ManagerListingSubmissionV1 = { ...sub, serviceRequestOptions: nextOffers };
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast(`Could not delete ${entityLabel}.`);
      return;
    }
    showToast(`${label} deleted.`);
    onClose();
    onSaved();
  };

  const workspaceTitle = isNew ? `Add ${entityLabel}` : `Edit ${entityLabel}`;
  const workspaceSteps: AddWorkspaceStep[] = [
    { id: "details", label: "Details", incomplete: !draft.name.trim(), summary: draft.name.trim() || "Name this request" },
    { id: "price", label: "Price", summary: draft.price.trim() || "No price yet" },
    { id: "preview", label: "Preview", summary: draft.available ? "Available" : "Unavailable" },
  ];
  const current = Math.min(stepIdx, workspaceSteps.length - 1);
  const stepId = workspaceSteps[current]!.id;

  if (!open) return null;

  return (
    <AddWorkspace
      title={workspaceTitle}
      steps={workspaceSteps}
      current={current}
      onJump={setStepIdx}
      onClose={onClose}
      dirty={Boolean(draft.name.trim() || draft.description.trim() || draft.price.trim())}
      discardTitle={`Discard this ${entityLabel}?`}
      assistantContext={workspaceTitle}
      assistantScopeKey="service-offering-workspace"
      sidePanel={
        <PreviewPanel
          title="Request preview"
          name={draft.name.trim() || `New ${entityLabel}`}
          sub={draft.description.trim() || undefined}
          facts={[
            { label: "Price", value: draft.price.trim() || "Not set", warn: !draft.price.trim() },
            { label: "Deposit", value: draft.deposit.trim() || "None" },
            { label: "Available", value: draft.available ? "Yes" : "No" },
          ]}
          creates={[
            { tone: draft.available ? "yes" : "no", text: draft.available ? "Residents can request this" : "Hidden from residents" },
          ]}
        />
      }
      lastLabel="Save"
      lastDisabled={!draft.name.trim()}
      onBeforeNext={() => {
        if (stepId === "details" && !draft.name.trim()) {
          setError(`${entityLabel.charAt(0).toUpperCase()}${entityLabel.slice(1)} name is required.`);
          return false;
        }
        setError(null);
        return true;
      }}
      onFinish={save}
      dataAttrPrefix="service-offering"
      finishDataAttr="service-offering-save"
      footerNote={error ? <span className="text-sm text-red-600">{error}</span> : null}
      dangerAction={
        !isNew && offering ? (
          <button
            type="button"
            className="min-h-[44px] rounded-full border border-red-200 bg-card px-6 text-[14px] font-bold text-red-700"
            data-attr="service-offering-delete"
            onClick={() => void remove()}
          >
            Delete
          </button>
        ) : null
      }
    >
      {stepId === "details" ? (
        <StepColumn>
          <StepHeading title="Details" />
          <div className="space-y-3">
            <ServiceOfferingFields row={draft} onPatch={patch} parts="details" />
          </div>
        </StepColumn>
      ) : null}
      {stepId === "price" ? (
        <StepColumn>
          <StepHeading title="Price" />
          <ServiceOfferingFields row={draft} onPatch={patch} parts="price" />
        </StepColumn>
      ) : null}
      {stepId === "preview" ? (
        <StepColumn>
          <StepHeading title="Preview" />
          <PreviewPanel
            title="Request preview"
            name={draft.name.trim() || `New ${entityLabel}`}
            sub={draft.description.trim() || undefined}
            facts={[
              { label: "Price", value: draft.price.trim() || "Not set", warn: !draft.price.trim() },
              { label: "Deposit", value: draft.deposit.trim() || "None" },
              { label: "Available", value: draft.available ? "Yes" : "No" },
            ]}
            creates={[
              { tone: draft.available ? "yes" : "no", text: draft.available ? "Residents can request this" : "Hidden from residents" },
            ]}
          />
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
