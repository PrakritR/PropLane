"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";
import {
  PreviewPanel,
  WizardField,
  WizardMultiSelect,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { CountStepper } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Input } from "@/components/ui/input";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { saveDispatchRule } from "@/lib/vendor-dispatch/dispatch-client";
import {
  DISPATCH_HOURS,
  DISPATCH_URGENCIES,
  DISPATCH_URGENCY_LABEL,
  MAX_CHAIN_LENGTH,
  defaultTimeoutForUrgencies,
  formatRulePay,
  type DispatchHours,
  type DispatchMode,
  type DispatchPropertyScope,
  type DispatchRule,
} from "@/lib/vendor-dispatch/rules";
import { VENDOR_TRADES, tradeDefinition, type DispatchUrgency } from "@/lib/vendor-dispatch/trades";
import {
  VENDOR_PAY_MODELS,
  centsToDollarsInput,
  dollarsInputToCents,
  vendorTakesRole,
  type VendorPayModel,
} from "@/lib/vendor-dispatch/vendor-roles";

type Draft = {
  stepIdx: number;
  name: string;
  trade: string;
  issue: string;
  propertyScope: DispatchPropertyScope;
  propertyIds: string[];
  urgencies: DispatchUrgency[];
  hours: DispatchHours;
  vendorIds: string[];
  mode: DispatchMode;
  broadcastSize: number;
  timeoutCustom: boolean;
  timeoutMinutes: number;
  pay: string;
  payModel: VendorPayModel;
  nte: string;
};

const TRADE_OPTIONS = VENDOR_TRADES.map((trade) => ({ value: trade.id, label: trade.label }));
const HOURS_OPTIONS = DISPATCH_HOURS.map((entry) => ({ value: entry.id, label: entry.label }));
const URGENCY_OPTIONS = DISPATCH_URGENCIES.map((urgency) => ({ value: urgency, label: DISPATCH_URGENCY_LABEL[urgency] }));
const PAY_MODEL_OPTIONS = VENDOR_PAY_MODELS.map((model) => ({ value: model.id, label: model.label }));
const SCOPE_OPTIONS = [
  { value: "all", label: "All houses" },
  { value: "selected", label: "Pick houses" },
];
const MODE_OPTIONS = [
  { value: "sequential", label: "One at a time" },
  { value: "broadcast", label: "Several at once" },
];

function freshDraft(): Draft {
  const trade = "locksmith";
  return {
    stepIdx: 0,
    name: "",
    trade,
    issue: "",
    propertyScope: "all",
    propertyIds: [],
    urgencies: [...DISPATCH_URGENCIES],
    hours: "any",
    vendorIds: [],
    mode: "sequential",
    broadcastSize: 3,
    timeoutCustom: false,
    timeoutMinutes: defaultTimeoutForUrgencies(DISPATCH_URGENCIES),
    pay: "",
    payModel: tradeDefinition(trade)?.defaultPayModel ?? "flat",
    nte: "",
  };
}

function draftFromRule(rule: DispatchRule): Draft {
  return {
    stepIdx: 0,
    name: rule.name,
    trade: rule.trade,
    issue: rule.issue ?? "",
    propertyScope: rule.propertyScope,
    propertyIds: rule.propertyIds,
    urgencies: rule.urgencies,
    hours: rule.hours,
    vendorIds: rule.vendors.slice().sort((a, b) => a.position - b.position).map((vendor) => vendor.vendorDirectoryId),
    mode: rule.mode,
    broadcastSize: rule.broadcastSize,
    timeoutCustom: rule.timeoutMinutes != null,
    timeoutMinutes: rule.timeoutMinutes ?? defaultTimeoutForUrgencies(rule.urgencies),
    pay: centsToDollarsInput(rule.payCents),
    payModel: rule.payModel,
    nte: centsToDollarsInput(rule.nteCents),
  };
}

function sanitizeMoney(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
}

/** The name a rule gets when the manager leaves it blank. */
export function suggestedRuleName(trade: string, issue: string): string {
  const def = tradeDefinition(trade);
  const issueLabel = def?.issues.find((entry) => entry.id === issue)?.label;
  return (issueLabel ?? def?.label ?? "Dispatch").slice(0, 80);
}

/**
 * Dispatch rule editor: the Add property pop-up standard (AddWorkspace).
 * Sections: Job, Houses, When, Vendors (the ordered chain), Offer, Pay.
 * Mobile is the same workspace as a bottom sheet. The server re-validates
 * every vendor and house id (`rules.server.ts`); this form only offers what
 * it will accept.
 */
export function DispatchRuleEditor({
  open,
  rule,
  vendors,
  houseOptions,
  onClose,
  showToast,
}: {
  open: boolean;
  /** The rule being edited, or null to create one. */
  rule: DispatchRule | null;
  vendors: readonly ManagerVendorRow[];
  houseOptions: readonly { id: string; label: string }[];
  onClose: () => void;
  showToast: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setDraft(rule ? draftFromRule(rule) : freshDraft());
  }, [open, rule]);

  const workspaceDraft = useWorkspaceDraft<Draft>({
    scope: `dispatch-rule:${rule?.id ?? "new"}`,
    open,
    value: draft,
    restore: (saved) => setDraft({ ...freshDraft(), ...saved }),
  });

  const tradeDef = tradeDefinition(draft.trade);
  const issueOptions = useMemo(
    () => [{ value: "", label: "Any issue" }, ...(tradeDef?.issues ?? []).map((issue) => ({ value: issue.id, label: issue.label }))],
    [tradeDef],
  );

  const vendorById = useMemo(() => new Map(vendors.map((vendor) => [vendor.id, vendor])), [vendors]);
  const addableGroups = useMemo(() => {
    const free = vendors.filter(
      (vendor) => vendor.name.trim() && vendor.active !== false && !draft.vendorIds.includes(vendor.id) && vendor.dispatchAvailable !== false,
    );
    const matching = free.filter((vendor) => vendorTakesRole(vendor, draft.trade));
    const others = free.filter((vendor) => !vendorTakesRole(vendor, draft.trade));
    const toOption = (vendor: ManagerVendorRow) => ({ value: vendor.id, label: vendor.name });
    const groups: { label: string; options: { value: string; label: string }[] }[] = [];
    if (matching.length) groups.push({ label: tradeDef?.label ?? "Matching vendors", options: matching.map(toOption) });
    if (others.length) groups.push({ label: matching.length ? "Other vendors" : "Your vendors", options: others.map(toOption) });
    return groups;
  }, [vendors, draft.vendorIds, draft.trade, tradeDef]);

  const houseLabel = (id: string) => houseOptions.find((option) => option.id === id)?.label ?? "House";
  const payCents = dollarsInputToCents(draft.pay);
  const nteCents = dollarsInputToCents(draft.nte);
  const jobOk = Boolean(tradeDef);
  const housesOk = draft.propertyScope === "all" || draft.propertyIds.length > 0;
  const whenOk = draft.urgencies.length > 0;
  const vendorsOk = draft.vendorIds.length > 0 && draft.vendorIds.length <= MAX_CHAIN_LENGTH;
  const canSave = jobOk && housesOk && whenOk && vendorsOk && !busy;
  const effectiveName = draft.name.trim() || suggestedRuleName(draft.trade, draft.issue);

  const steps: AddWorkspaceStep[] = [
    { id: "job", label: "Job", incomplete: !jobOk },
    { id: "houses", label: "Houses", incomplete: !housesOk },
    { id: "when", label: "When", incomplete: !whenOk },
    { id: "vendors", label: "Vendors", incomplete: !vendorsOk },
    { id: "offer", label: "Offer" },
    { id: "pay", label: "Pay" },
  ];
  const current = Math.min(draft.stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  const moveVendor = (index: number, delta: -1 | 1) => {
    const next = draft.vendorIds.slice();
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    set({ vendorIds: next });
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const result = await saveDispatchRule(rule?.id ?? null, {
      name: effectiveName,
      trade: draft.trade,
      issue: draft.issue || null,
      propertyScope: draft.propertyScope,
      propertyIds: draft.propertyScope === "selected" ? draft.propertyIds : [],
      urgencies: draft.urgencies,
      hours: draft.hours,
      vendorIds: draft.vendorIds,
      mode: draft.mode,
      broadcastSize: draft.broadcastSize,
      timeoutMinutes: draft.timeoutCustom ? draft.timeoutMinutes : null,
      payCents,
      payModel: draft.payModel,
      nteCents,
      active: rule ? rule.active : true,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    workspaceDraft.clear();
    showToast(rule ? "Rule saved." : "Rule added.");
    onClose();
  };

  if (!open) return null;

  const housesText =
    draft.propertyScope === "all"
      ? "All houses"
      : draft.propertyIds.length === 0
        ? "Not set"
        : draft.propertyIds.map(houseLabel).join(", ");

  return (
    <div data-attr="dispatch-rule-editor">
      <AddWorkspace
        title={rule ? "Edit rule" : "Add rule"}
        steps={steps}
        current={current}
        onJump={(index) => set({ stepIdx: index })}
        onClose={() => {
          workspaceDraft.preserve();
          onClose();
        }}
        keepsDraft
        onDiscardDraft={() => {
          workspaceDraft.clear();
          setDraft(rule ? draftFromRule(rule) : freshDraft());
        }}
        dirty={Boolean(draft.name.trim() || draft.vendorIds.length)}
        discardTitle="Discard this rule?"
        assistantContext="Setting up who PropLane offers a job to."
        assistantScopeKey="dispatch-rule"
        lastLabel={rule ? "Save rule" : "Add rule"}
        lastDisabled={!canSave}
        busy={busy}
        onFinish={() => void save()}
        dataAttrPrefix="dispatch-rule"
        finishDataAttr="dispatch-rule-save"
        sidePanel={
          <PreviewPanel
            title="Rule preview"
            name={effectiveName}
            sub={tradeDef?.label}
            facts={[
              { label: "Houses", value: housesText, warn: !housesOk },
              { label: "Vendors", value: draft.vendorIds.length ? String(draft.vendorIds.length) : "None", warn: !vendorsOk },
              { label: "Offer", value: draft.mode === "broadcast" ? `${draft.broadcastSize} at once` : "One at a time" },
              { label: "Pay", value: formatRulePay(payCents, draft.payModel) },
            ]}
          />
        }
      >
        {stepId === "job" ? (
          <WizardSection title="Job">
            <WizardSelect
              label="Job type *"
              value={draft.trade}
              onChange={(trade) =>
                set({ trade, issue: "", payModel: tradeDefinition(trade)?.defaultPayModel ?? draft.payModel })
              }
              options={TRADE_OPTIONS}
              dataAttr="dispatch-rule-trade"
            />
            <div className="mt-3">
              <WizardSelect
                label="Issue"
                value={draft.issue}
                onChange={(issue) => set({ issue })}
                options={issueOptions}
                dataAttr="dispatch-rule-issue"
              />
            </div>
            <div className="mt-3">
              <WizardField label="Name">
                <Input
                  value={draft.name}
                  onChange={(e) => set({ name: e.target.value })}
                  maxLength={80}
                  placeholder={suggestedRuleName(draft.trade, draft.issue)}
                  data-attr="dispatch-rule-name"
                />
              </WizardField>
            </div>
          </WizardSection>
        ) : null}

        {stepId === "houses" ? (
          <WizardSection title="Houses">
            <WizardSelect
              label="Applies to"
              value={draft.propertyScope}
              onChange={(next) => set({ propertyScope: next as DispatchPropertyScope })}
              options={SCOPE_OPTIONS}
              dataAttr="dispatch-rule-scope"
            />
            {draft.propertyScope === "selected" ? (
              <div className="mt-3">
                <WizardMultiSelect
                  label="Houses *"
                  required
                  options={houseOptions.map((option) => ({ value: option.id, label: option.label }))}
                  selected={draft.propertyIds}
                  onChange={(propertyIds) => set({ propertyIds })}
                  emptyLabel="Pick houses"
                  emptyMenuText="No houses"
                  dataAttr="dispatch-rule-houses"
                />
              </div>
            ) : null}
          </WizardSection>
        ) : null}

        {stepId === "when" ? (
          <WizardSection title="When">
            <WizardMultiSelect
              label="Urgency *"
              required
              options={URGENCY_OPTIONS}
              selected={draft.urgencies}
              onChange={(next) => {
                const urgencies = DISPATCH_URGENCIES.filter((urgency) => next.includes(urgency));
                set({
                  urgencies,
                  timeoutMinutes: draft.timeoutCustom ? draft.timeoutMinutes : defaultTimeoutForUrgencies(urgencies),
                });
              }}
              dataAttr="dispatch-rule-urgency"
            />
            <div className="mt-3">
              <WizardSelect
                label="Hours"
                value={draft.hours}
                onChange={(hours) => set({ hours: hours as DispatchHours })}
                options={HOURS_OPTIONS}
                dataAttr="dispatch-rule-hours"
              />
            </div>
          </WizardSection>
        ) : null}

        {stepId === "vendors" ? (
          <WizardSection title="Vendors">
            <ol className="space-y-2" data-attr="dispatch-rule-chain">
              {draft.vendorIds.map((vendorId, index) => (
                <li
                  key={vendorId}
                  className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-3"
                  data-attr="dispatch-rule-chain-row"
                >
                  <span className="w-16 shrink-0 text-[12.5px] font-semibold text-muted">{index === 0 ? "Primary" : `Backup ${index}`}</span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">
                    {vendorById.get(vendorId)?.name ?? rule?.vendors.find((entry) => entry.vendorDirectoryId === vendorId)?.name ?? "Vendor"}
                  </span>
                  <PortalIconAction
                    icon={ArrowUp}
                    label="Move up"
                    ariaLabel={`Move ${vendorById.get(vendorId)?.name ?? "vendor"} up`}
                    disabled={index === 0}
                    onClick={() => moveVendor(index, -1)}
                    data-attr="dispatch-rule-chain-up"
                  />
                  <PortalIconAction
                    icon={ArrowDown}
                    label="Move down"
                    ariaLabel={`Move ${vendorById.get(vendorId)?.name ?? "vendor"} down`}
                    disabled={index === draft.vendorIds.length - 1}
                    onClick={() => moveVendor(index, 1)}
                    data-attr="dispatch-rule-chain-down"
                  />
                  <PortalIconAction
                    icon={X}
                    label="Remove"
                    ariaLabel={`Remove ${vendorById.get(vendorId)?.name ?? "vendor"}`}
                    onClick={() => set({ vendorIds: draft.vendorIds.filter((id) => id !== vendorId) })}
                    data-attr="dispatch-rule-chain-remove"
                  />
                </li>
              ))}
            </ol>
            {draft.vendorIds.length < MAX_CHAIN_LENGTH ? (
              <div className={draft.vendorIds.length ? "mt-3" : ""}>
                <WizardSelect
                  label={draft.vendorIds.length === 0 ? "Primary vendor *" : "Add a backup"}
                  value=""
                  placeholder={addableGroups.length ? "Pick a vendor" : "No vendors to add"}
                  onChange={(vendorId) => {
                    if (vendorId && !draft.vendorIds.includes(vendorId)) set({ vendorIds: [...draft.vendorIds, vendorId] });
                  }}
                  groups={addableGroups}
                  disabled={addableGroups.length === 0}
                  dataAttr="dispatch-rule-add-vendor"
                />
              </div>
            ) : null}
          </WizardSection>
        ) : null}

        {stepId === "offer" ? (
          <WizardSection title="Offer">
            <WizardSelect
              label="Send the job"
              value={draft.mode}
              onChange={(mode) => set({ mode: mode as DispatchMode })}
              options={MODE_OPTIONS}
              dataAttr="dispatch-rule-mode"
            />
            {draft.mode === "broadcast" ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-[13px] font-semibold text-foreground">Vendors at once</span>
                <CountStepper
                  value={draft.broadcastSize}
                  min={2}
                  max={10}
                  onChange={(broadcastSize) => set({ broadcastSize })}
                  label="vendors at once"
                  dataAttr="dispatch-rule-broadcast-size"
                />
              </div>
            ) : null}
            <div className="mt-3">
              <WizardSelect
                label="Wait for an answer"
                value={draft.timeoutCustom ? "custom" : "default"}
                onChange={(next) => set({ timeoutCustom: next === "custom" })}
                options={[
                  { value: "default", label: `${defaultTimeoutForUrgencies(draft.urgencies)} min (by urgency)` },
                  { value: "custom", label: "Set my own" },
                ]}
                dataAttr="dispatch-rule-timeout-mode"
              />
            </div>
            {draft.timeoutCustom ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-[13px] font-semibold text-foreground">Minutes</span>
                <CountStepper
                  value={draft.timeoutMinutes}
                  min={5}
                  max={1440}
                  step={5}
                  onChange={(timeoutMinutes) => set({ timeoutMinutes })}
                  label="minutes to wait"
                  dataAttr="dispatch-rule-timeout"
                />
              </div>
            ) : null}
          </WizardSection>
        ) : null}

        {stepId === "pay" ? (
          <WizardSection title="Pay">
            <WizardRow>
              <WizardField label="Amount">
                <Input
                  value={draft.pay}
                  onChange={(e) => set({ pay: sanitizeMoney(e.target.value) })}
                  inputMode="decimal"
                  placeholder="$"
                  data-attr="dispatch-rule-pay"
                />
              </WizardField>
              <WizardSelect
                label="Paid"
                value={draft.payModel}
                onChange={(payModel) => set({ payModel: payModel as VendorPayModel })}
                options={PAY_MODEL_OPTIONS}
                dataAttr="dispatch-rule-pay-model"
              />
            </WizardRow>
            <div className="mt-3">
              <WizardField label="Cap">
                <Input
                  value={draft.nte}
                  onChange={(e) => set({ nte: sanitizeMoney(e.target.value) })}
                  inputMode="decimal"
                  placeholder="$"
                  data-attr="dispatch-rule-cap"
                />
              </WizardField>
            </div>
          </WizardSection>
        ) : null}

        {error ? (
          <p role="alert" className="mt-2 text-sm font-semibold text-danger" data-attr="dispatch-rule-error">
            {error}
          </p>
        ) : null}
      </AddWorkspace>
    </div>
  );
}
