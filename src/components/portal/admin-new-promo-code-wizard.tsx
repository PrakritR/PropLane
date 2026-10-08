"use client";

import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";
import {
  PreviewPanel,
  ReviewCard,
  WizardField,
  WizardLine,
  WizardMultiSelect,
  WizardSection,
  WizardSelect,
  WizardStepper,
} from "@/components/portal/add-workspace/parts";
import { CountStepper } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import {
  describePromoDiscount,
  describePromoPlans,
  formatPromoDate,
  type PromoDiscountType,
  type PromoDuration,
} from "@/lib/admin/promo-code-terms";
import {
  ADMIN_PROMO_CODE_PATTERN,
  PROMO_PLAN_IDS,
  PROMO_PLAN_LABELS,
  isInternalWaiverPromoCode,
  normalizePromoCodeInput,
  type PromoPlanId,
} from "@/lib/stripe-promos";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";

type Draft = {
  stepIdx: number;
  code: string;
  codeTouched: boolean;
  name: string;
  discountType: PromoDiscountType;
  value: number;
  duration: PromoDuration;
  durationMonths: number;
  plans: PromoPlanId[];
  firstTimeOnly: boolean;
  limited: boolean;
  maxRedemptions: number;
  expiresOn: string;
};

const FRESH: Draft = {
  stepIdx: 0,
  code: "",
  codeTouched: false,
  name: "",
  discountType: "free_months",
  value: 1,
  duration: "once",
  durationMonths: 3,
  plans: [],
  firstTimeOnly: true,
  limited: true,
  maxRedemptions: 50,
  expiresOn: "",
};

const DISCOUNT_TYPES: { value: PromoDiscountType; label: string }[] = [
  { value: "free_months", label: "Free months" },
  { value: "percent", label: "Percent off" },
  { value: "amount", label: "Amount off" },
];

const DURATIONS: { value: PromoDuration; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "repeating", label: "For several months" },
  { value: "forever", label: "Forever" },
];

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

const USES = [
  { value: "limited", label: "Limited" },
  { value: "unlimited", label: "Unlimited" },
];

function suggestCode(name: string): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12);
  return base;
}

function randomSuggestion(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "PL";
  for (let i = 0; i < 4; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function valueRange(type: PromoDiscountType): { min: number; max: number } {
  if (type === "percent") return { min: 1, max: 100 };
  if (type === "amount") return { min: 1, max: 1000 };
  return { min: 1, max: 36 };
}

function codeProblem(code: string): string | null {
  if (!code) return "Code is required.";
  if (!ADMIN_PROMO_CODE_PATTERN.test(code)) return "Use 3 to 32 letters, numbers, dashes or underscores.";
  if (isInternalWaiverPromoCode(code)) return "That code is reserved.";
  return null;
}

/**
 * New promo code — the New property wizard standard (AddWorkspace): header with Draft saved and the close
 * x, step rail, live preview flush right, centred "Step n of 4", Back / Next. Creating a code makes a
 * Stripe coupon plus a Stripe promotion code (decision D1: Stripe-native), so Checkout accepts it on
 * every plan the code applies to.
 */
export function AdminNewPromoCodeWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(FRESH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setDraft((prev) => (prev.code ? prev : { ...prev, code: randomSuggestion() }));
  }, [open]);

  const workspaceDraft = useWorkspaceDraft<Draft>({
    scope: "admin-new-promo-code",
    open,
    value: draft,
    restore: (saved) => setDraft(saved),
  });

  const code = normalizePromoCodeInput(draft.code);
  const problem = codeProblem(code);
  const range = valueRange(draft.discountType);
  const valueOk = draft.value >= range.min && draft.value <= range.max;
  const expiresOk = !draft.expiresOn || draft.expiresOn > pacificCalendarDateYmd();
  const maxUses = draft.limited ? draft.maxRedemptions : null;

  const terms = useMemo(
    () => ({
      discountType: draft.discountType,
      value: draft.value,
      duration: draft.duration,
      durationMonths: draft.durationMonths,
    }),
    [draft.discountType, draft.value, draft.duration, draft.durationMonths],
  );
  const discountText = describePromoDiscount(terms);
  const plansText = describePromoPlans(draft.plans);
  const expiresText = draft.expiresOn ? formatPromoDate(`${draft.expiresOn}T00:00:00Z`) : "Never";

  const steps: AddWorkspaceStep[] = [
    { id: "code", label: "Code", incomplete: Boolean(problem), summary: code || "Pick a code" },
    { id: "discount", label: "Discount", incomplete: !valueOk, summary: discountText },
    { id: "applies", label: "Applies to", incomplete: !expiresOk, summary: plansText },
    { id: "review", label: "Review", summary: "Create code" },
  ];
  const current = Math.min(draft.stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  const canCreate = !problem && valueOk && expiresOk && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/promo-codes", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name: draft.name.trim(),
          discountType: draft.discountType,
          value: draft.value,
          duration: draft.discountType === "free_months" ? "once" : draft.duration,
          durationMonths: draft.duration === "repeating" && draft.discountType !== "free_months" ? draft.durationMonths : null,
          plans: draft.plans,
          firstTimeOnly: draft.firstTimeOnly,
          maxRedemptions: maxUses,
          expiresOn: draft.expiresOn || null,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Could not create the code.");
        return;
      }
      workspaceDraft.clear();
      setDraft({ ...FRESH, code: randomSuggestion() });
      onCreated(code);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div data-attr="admin-new-promo-code-wizard">
      <AddWorkspace
        title="New promo code"
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
          setDraft({ ...FRESH, code: randomSuggestion() });
        }}
        dirty={Boolean(draft.name || draft.expiresOn)}
        discardTitle="Discard this promo code?"
        assistantContext="Creating a Stripe promo code for PropLane plans."
        assistantScopeKey="admin-new-promo-code"
        lastLabel="Create code"
        lastDisabled={!canCreate}
        nextDisabled={
          (stepId === "code" && Boolean(problem)) ||
          (stepId === "discount" && !valueOk) ||
          (stepId === "applies" && !expiresOk)
        }
        busy={busy}
        onFinish={() => void create()}
        dataAttrPrefix="admin-new-promo-code"
        finishDataAttr="admin-new-promo-code-create"
        sidePanel={
          <PreviewPanel
            title="Promo preview"
            name={code || "Code"}
            sub={discountText}
            facts={[
              { label: "Applies to", value: plansText },
              { label: "Uses", value: maxUses ? `${maxUses}` : "Unlimited" },
              { label: "Expires", value: expiresText },
              { label: "New customers only", value: draft.firstTimeOnly ? "Yes" : "No" },
            ]}
            creates={[
              { tone: problem ? "warn" : "yes", text: "A Stripe coupon and promotion code" },
              { tone: "yes", text: "Accepted at checkout on the plans above" },
            ]}
          />
        }
      >
        {stepId === "code" ? (
          <WizardSection title="Code">
            <WizardField label="Code" required>
              <Input
                value={draft.code}
                onChange={(e) => set({ code: normalizePromoCodeInput(e.target.value), codeTouched: true })}
                maxLength={32}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(problem) && draft.codeTouched}
                data-attr="admin-promo-code-input"
              />
            </WizardField>
            {problem && draft.codeTouched ? (
              <p role="alert" className="mt-2 text-sm font-semibold text-danger">
                {problem}
              </p>
            ) : null}
            <div className="mt-4">
              <WizardField label="Name">
                <Input
                  value={draft.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    set(draft.codeTouched ? { name } : { name, code: suggestCode(name) || draft.code });
                  }}
                  maxLength={80}
                  data-attr="admin-promo-name-input"
                />
              </WizardField>
            </div>
          </WizardSection>
        ) : null}

        {stepId === "discount" ? (
          <WizardSection title="Discount">
            <WizardSelect
              label="Type"
              value={draft.discountType}
              onChange={(next) => {
                const type = next as PromoDiscountType;
                const r = valueRange(type);
                set({
                  discountType: type,
                  value: Math.min(r.max, Math.max(r.min, type === "free_months" ? 1 : type === "percent" ? 20 : 10)),
                  duration: type === "free_months" ? "once" : draft.duration,
                });
              }}
              options={DISCOUNT_TYPES}
              dataAttr="admin-promo-type"
            />
            <div className="mt-3">
              <WizardLine
                label={draft.discountType === "percent" ? "Percent off" : draft.discountType === "amount" ? "Dollars off" : "Free months"}
                control={
                  <WizardStepper
                    value={draft.value}
                    min={range.min}
                    max={range.max}
                    label="discount value"
                    onChange={(value) => set({ value })}
                    dataAttr="admin-promo-value"
                  />
                }
              />
            </div>
            {draft.discountType !== "free_months" ? (
              <div className="mt-3 space-y-3">
                <WizardSelect
                  label="Duration"
                  value={draft.duration}
                  onChange={(next) => set({ duration: next as PromoDuration })}
                  options={DURATIONS}
                  dataAttr="admin-promo-duration"
                />
                {draft.duration === "repeating" ? (
                  <WizardLine
                    label="Months"
                    control={
                      <WizardStepper
                        value={draft.durationMonths}
                        min={1}
                        max={36}
                        label="months"
                        onChange={(durationMonths) => set({ durationMonths })}
                        dataAttr="admin-promo-months"
                      />
                    }
                  />
                ) : null}
              </div>
            ) : null}
          </WizardSection>
        ) : null}

        {stepId === "applies" ? (
          <WizardSection title="Applies to">
            <WizardMultiSelect
              label="Plans"
              options={PROMO_PLAN_IDS.map((id) => ({ value: id, label: PROMO_PLAN_LABELS[id] }))}
              selected={draft.plans}
              onChange={(next) => set({ plans: next as PromoPlanId[] })}
              emptyLabel="Every plan"
              dataAttr="admin-promo-plans"
            />
            <div className="mt-3 space-y-3">
              <WizardSelect
                label="First-time customers only"
                value={draft.firstTimeOnly ? "yes" : "no"}
                onChange={(next) => set({ firstTimeOnly: next === "yes" })}
                options={YES_NO}
                dataAttr="admin-promo-first-time"
              />
              <WizardSelect
                label="Uses"
                value={draft.limited ? "limited" : "unlimited"}
                onChange={(next) => set({ limited: next === "limited" })}
                options={USES}
                dataAttr="admin-promo-uses"
              />
              {draft.limited ? (
                <WizardLine
                  label="Max uses"
                  control={
                    <CountStepper
                      value={draft.maxRedemptions}
                      min={5}
                      max={10000}
                      step={5}
                      label="max uses"
                      compact
                      onChange={(maxRedemptions) => set({ maxRedemptions })}
                      dataAttr="admin-promo-max-uses"
                    />
                  }
                />
              ) : null}
              <WizardField label="Expires">
                <DateField
                  value={draft.expiresOn}
                  onChange={(expiresOn) => set({ expiresOn })}
                  min={pacificCalendarDateYmd()}
                  data-attr="admin-promo-expires"
                />
              </WizardField>
              {!expiresOk ? (
                <p role="alert" className="text-sm font-semibold text-danger">
                  Pick a date in the future.
                </p>
              ) : null}
            </div>
          </WizardSection>
        ) : null}

        {stepId === "review" ? (
          <div>
            <ReviewCard
              title="Code"
              status={problem ? "incomplete" : "complete"}
              onEdit={() => set({ stepIdx: 0 })}
              facts={[
                { label: "Code", value: code || "Not set", missing: Boolean(problem) },
                { label: "Name", value: draft.name.trim() || code || "Not set" },
              ]}
            />
            <ReviewCard
              title="Discount"
              status={valueOk ? "complete" : "incomplete"}
              onEdit={() => set({ stepIdx: 1 })}
              facts={[{ label: "Discount", value: discountText }]}
            />
            <ReviewCard
              title="Applies to"
              status={expiresOk ? "complete" : "incomplete"}
              onEdit={() => set({ stepIdx: 2 })}
              facts={[
                { label: "Plans", value: plansText },
                { label: "New customers only", value: draft.firstTimeOnly ? "Yes" : "No" },
                { label: "Uses", value: maxUses ? `${maxUses}` : "Unlimited" },
                { label: "Expires", value: expiresText },
              ]}
            />
            {error ? (
              <p role="alert" className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold portal-banner-danger">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </AddWorkspace>
    </div>
  );
}
