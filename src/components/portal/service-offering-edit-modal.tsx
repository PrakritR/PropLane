"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Clock, Wrench } from "lucide-react";
import { Input, Textarea } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { FactRow, MoneyInput, ToggleRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { useConfirm } from "@/components/providers/app-ui-provider";
import {
  createManagerListingServiceOption,
  LISTING_SERVICE_QUICK_ADDS,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
  type ServiceBillingCadence,
} from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";

function RpSvcBand({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <p
      className={
        first
          ? "px-3.5 pb-1 pt-3.5 text-[15.5px] font-bold tracking-tight text-foreground"
          : "border-t border-border/60 px-3.5 pb-1 pt-3.5 text-[15.5px] font-bold tracking-tight text-foreground"
      }
    >
      {children}
    </p>
  );
}

function cadenceLabel(cadence: ServiceBillingCadence | undefined): string {
  if (cadence === "monthly") return "per month";
  if (cadence === "one_time") return "one time";
  return "per request";
}

function ServiceResidentPreview({
  draft,
  needsApproval,
}: {
  draft: ManagerListingServiceOption;
  needsApproval: boolean;
}) {
  const name = draft.name.trim() || "New service";
  const desc = draft.description.trim();
  const priceRaw = draft.price.trim();
  const cad = cadenceLabel(draft.billingCadence);
  const priceLine =
    priceRaw && parseFloat(priceRaw.replace(/[^0-9.]/g, "")) > 0
      ? `${priceRaw} ${cad}`
      : "Ask";
  const dep = draft.deposit.trim();
  const depNum = dep ? parseFloat(dep.replace(/[^0-9.]/g, "")) : 0;

  return (
    <div className="pv-svc rounded-2xl border border-border bg-card p-4" data-attr="service-offering-resident-preview">
      <div className="flex gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/[0.08] text-primary">
          <Wrench className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-foreground">{name}</div>
          {desc ? <div className="mt-1 text-[13px] font-medium text-muted">{desc}</div> : null}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
        <div>
          <span className="block text-[11px] font-bold uppercase tracking-wide text-muted">Price</span>
          <b className="text-[14px] text-foreground">{priceLine}</b>
        </div>
        {depNum > 0 ? (
          <div>
            <span className="block text-[11px] font-bold uppercase tracking-wide text-muted">Deposit</span>
            <b className="text-[14px] text-foreground">{dep}</b>
          </div>
        ) : null}
      </div>
      {needsApproval ? (
        <div className="mt-3 flex items-center gap-2 text-[13px] font-semibold text-muted">
          <Clock className="h-4 w-4 shrink-0" aria-hidden />
          <span>Needs approval</span>
        </div>
      ) : null}
      <div
        className={
          draft.available
            ? "mt-4 rounded-xl bg-primary py-2.5 text-center text-[14px] font-bold text-primary-foreground"
            : "mt-4 rounded-xl border border-border py-2.5 text-center text-[14px] font-bold text-muted"
        }
      >
        {draft.available ? "Request" : "Not available"}
      </div>
    </div>
  );
}

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

function WizardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-bold text-foreground">{label}</span>
      {children}
    </label>
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

function buildNameOptions(
  sub: ManagerListingSubmissionV1,
  current: ManagerListingServiceOption | null,
): { value: string; label: string }[] {
  const taken = new Set(
    (sub.serviceRequestOptions ?? [])
      .filter((o) => !current || o.id !== current.id)
      .map((o) => o.name.trim().toLowerCase())
      .filter(Boolean),
  );
  const opts: { value: string; label: string }[] = [];
  for (const quick of LISTING_SERVICE_QUICK_ADDS) {
    const key = quick.name.toLowerCase();
    if (!taken.has(key)) opts.push({ value: `preset:${key}`, label: quick.name });
  }
  if (current?.name.trim()) {
    const key = current.name.trim().toLowerCase();
    if (!opts.some((o) => o.label.toLowerCase() === key)) {
      opts.unshift({ value: `preset:${key}`, label: current.name.trim() });
    }
  }
  opts.push({ value: "other", label: "Other" });
  return opts;
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
  const [namePick, setNamePick] = useState("other");
  const [customName, setCustomName] = useState("");
  const [requestAudience, setRequestAudience] = useState<"residents" | "residents_applicants">(
    sub.propertyServiceSettings?.requestAudience ?? "residents",
  );
  const [approveEachRequest, setApproveEachRequest] = useState(
    sub.propertyServiceSettings?.approveEachRequest ?? false,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const base = offering ? { ...offering } : createManagerListingServiceOption();
    setDraft(base);
    setError(null);
    setRequestAudience(sub.propertyServiceSettings?.requestAudience ?? "residents");
    setApproveEachRequest(sub.propertyServiceSettings?.approveEachRequest ?? false);
    const opts = buildNameOptions(sub, offering);
    const match = opts.find((o) => o.label.toLowerCase() === base.name.trim().toLowerCase());
    if (match && match.value !== "other") {
      setNamePick(match.value);
      setCustomName("");
    } else if (base.name.trim()) {
      setNamePick("other");
      setCustomName(base.name.trim());
    } else {
      setNamePick(opts[0]?.value ?? "other");
      setCustomName("");
    }
  }, [open, offering, sub]);

  const nameOptions = useMemo(() => buildNameOptions(sub, offering), [sub, offering]);

  const patch = (patchRow: Partial<ManagerListingServiceOption>) =>
    setDraft((prev) => ({ ...prev, ...patchRow }));

  const applyNamePick = (value: string) => {
    setNamePick(value);
    if (value === "other") return;
    const label = nameOptions.find((o) => o.value === value)?.label ?? "";
    const quick = LISTING_SERVICE_QUICK_ADDS.find((q) => q.name.toLowerCase() === label.toLowerCase());
    patch({
      name: label,
      description: quick?.description ?? draft.description,
      price: quick?.price ?? draft.price,
      deposit: quick?.deposit ?? draft.deposit,
    });
    setCustomName("");
  };

  const resolvedName = namePick === "other" ? customName.trim() : draft.name.trim();

  const save = () => {
    const normalized = normalizeOffering({
      ...draft,
      name: resolvedName,
      billingCadence: draft.billingCadence ?? "per_request",
    });
    if (!normalized.name) {
      setError(`${entityLabel.charAt(0).toUpperCase()}${entityLabel.slice(1)} name is required.`);
      return;
    }

    const offers = sub.serviceRequestOptions ?? [];
    const dup = offers.some(
      (o) => o.id !== normalized.id && o.name.trim().toLowerCase() === normalized.name.toLowerCase(),
    );
    if (dup) {
      setError(`${normalized.name} is already in this list.`);
      return;
    }

    const nextOffers = isNew
      ? [normalized, ...offers]
      : offers.map((o) => (o.id === normalized.id ? normalized : o));

    const next: ManagerListingSubmissionV1 = {
      ...sub,
      serviceRequestOptions: nextOffers,
      propertyServiceSettings: {
        ...sub.propertyServiceSettings,
        requestAudience,
        approveEachRequest,
      },
    };
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
    {
      id: "service",
      label: "Service",
      incomplete: !resolvedName,
      summary: resolvedName || "Name this request",
    },
  ];

  if (!open) return null;

  const cadence = draft.billingCadence ?? "per_request";

  return (
    <AddWorkspace
      title={workspaceTitle}
      steps={workspaceSteps}
      current={0}
      onJump={() => {}}
      onClose={onClose}
      dirty={Boolean(resolvedName || draft.description.trim() || draft.price.trim())}
      discardTitle={`Discard this ${entityLabel}?`}
      assistantContext={workspaceTitle}
      assistantScopeKey="service-offering-workspace"
      sidePanel={
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Resident sees</p>
          <ServiceResidentPreview draft={{ ...draft, name: resolvedName || draft.name }} needsApproval={approveEachRequest} />
        </div>
      }
      lastLabel="Save"
      lastDisabled={!resolvedName}
      onFinish={save}
      dataAttrPrefix="service-offering"
      hideFooterStepCount
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
      <div className="ps40-form" data-ps40-svc-form>
        <div className="rp-svc overflow-hidden rounded-2xl border border-border bg-card">
          <RpSvcBand first>Service</RpSvcBand>
          <FactRow label="Name" first required>
            <FieldSingleSelect
              label="Name"
              hideLabel
              options={nameOptions}
              value={namePick}
              onChange={applyNamePick}
              dataAttr="service-offering-name"
            />
          </FactRow>
          {namePick === "other" ? (
            <FactRow label="Service name">
              <Input
                value={customName}
                onChange={(e) => {
                  setCustomName(e.target.value);
                  patch({ name: e.target.value });
                }}
                placeholder="e.g. Window washing"
                aria-label="Service name"
              />
            </FactRow>
          ) : null}
          <FactRow label="Description" sub>
            <Textarea
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="What the resident gets"
              rows={2}
              className="min-h-[72px] resize-y text-[14px] font-semibold"
              aria-label="Description"
            />
          </FactRow>

          <RpSvcBand>Pricing</RpSvcBand>
          <FactRow label="Price" first>
            <MoneyInput label="Price" value={draft.price} onChange={(v) => patch({ price: v })} />
          </FactRow>
          <FactRow label="Charged">
            <FieldSingleSelect
              label="Charged"
              hideLabel
              value={cadence}
              onChange={(v) => patch({ billingCadence: v as ServiceBillingCadence })}
              options={[
                { value: "per_request", label: "Per request" },
                { value: "monthly", label: "Monthly" },
                { value: "one_time", label: "One time" },
              ]}
              dataAttr="service-offering-cadence"
            />
          </FactRow>
          <FactRow label="Deposit">
            <MoneyInput label="Deposit" value={draft.deposit} onChange={(v) => patch({ deposit: v })} />
          </FactRow>

          <RpSvcBand>Requests</RpSvcBand>
          <ToggleRow
            label="Available to request"
            checked={draft.available}
            onChange={(on) => patch({ available: on })}
            dataAttr="service-offering-available"
          />
          <FactRow label="Who can request">
            <FieldSingleSelect
              label="Who can request"
              hideLabel
              value={requestAudience}
              onChange={(v) => setRequestAudience(v as "residents" | "residents_applicants")}
              options={[
                { value: "residents", label: "Residents of this property" },
                { value: "residents_applicants", label: "Residents and approved applicants" },
              ]}
              dataAttr="service-offering-audience"
            />
          </FactRow>
          <ToggleRow
            label="Needs your approval"
            checked={approveEachRequest}
            onChange={setApproveEachRequest}
            dataAttr="service-offering-approval"
          />
        </div>
      </div>
    </AddWorkspace>
  );
}
