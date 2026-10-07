"use client";

import { Minus, Plus } from "lucide-react";
import { FactRowReset } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  PortalSettingsGroup,
  PortalSettingsRow,
  PortalSettingsSection,
  PortalSettingsToggle,
} from "@/components/portal/portal-settings-ui";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { parseSanitizedInteger, sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  SERVICE_FEE_PAYER_OPTION_LABELS,
  normalizeListingPaymentWaiverCode,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { isProcessingCoverageCodeShape } from "@/lib/processing-coverage-codes";
import {
  markPaymentFieldOwn,
  paymentSettingsFieldScope,
  paymentSettingsScopeLabel,
  resetPaymentFieldToWorkspace,
  type PaymentSettingsField,
} from "@/lib/property-payment-settings-scope";

export type WorkspacePaymentDefaults = {
  serviceFeePayer?: ServiceFeePayer | null;
};

const RENT_DUE_OPTIONS = [
  { value: "first_of_month", label: "1st of the month" },
  { value: "last_of_month", label: "Last day of the month" },
];

const PAYER_OPTIONS = (["resident", "manager", "proplane"] as ServiceFeePayer[]).map((value) => ({
  value,
  label: SERVICE_FEE_PAYER_OPTION_LABELS[value],
}));

const GRACE_MIN_DAYS = 0;
const GRACE_MAX_DAYS = 30;

function clampGraceDays(n: number): number {
  return Math.min(GRACE_MAX_DAYS, Math.max(GRACE_MIN_DAYS, Math.round(n)));
}

function GraceDaysStepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const commit = (n: number) => {
    if (!Number.isFinite(n)) return;
    onChange(clampGraceDays(n));
  };
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        aria-label="Decrease grace days"
        disabled={value <= GRACE_MIN_DAYS}
        onClick={() => commit(value - 1)}
        data-attr="property-payment-grace-days-decrement"
        className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Minus className="size-3.5" aria-hidden />
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label="Grace days"
        min={GRACE_MIN_DAYS}
        max={GRACE_MAX_DAYS}
        step={1}
        value={value}
        data-attr="property-payment-grace-days"
        onChange={(e) => commit(parseSanitizedInteger(e.target.value, value))}
        className="h-8 w-14 rounded-lg border border-border bg-card text-center text-sm font-semibold tabular-nums text-foreground [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-primary/30 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label="Increase grace days"
        disabled={value >= GRACE_MAX_DAYS}
        onClick={() => commit(value + 1)}
        data-attr="property-payment-grace-days-increment"
        className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}

/**
 * The property's own rent-due, late-fee and processing-fee answers, on the
 * record's Pricing tab.
 *
 * Settings › Balance & payouts › Rent & fees sets the workspace's answers; this
 * card is where one property departs from them. Each row names which of the two
 * it is currently on, and a row the property took over offers the way back.
 */
export function PropertyPaymentSettingsCard({
  sub,
  workspacePayment = null,
  onDraft,
  onCommit,
}: {
  sub: ManagerListingSubmissionV1;
  /** The workspace's saved answers, so a row's scope and its reset use the real default. */
  workspacePayment?: WorkspacePaymentDefaults | null;
  /** A keystroke: show it, do not save it yet. */
  onDraft: (next: ManagerListingSubmissionV1) => void;
  /** A settled answer: show it and save it. */
  onCommit: (next: ManagerListingSubmissionV1) => void;
}) {
  const commitOwn = (field: PaymentSettingsField, next: Partial<ManagerListingSubmissionV1>) =>
    onCommit(markPaymentFieldOwn({ ...sub, ...next }, field));
  const draftOwn = (field: PaymentSettingsField, next: Partial<ManagerListingSubmissionV1>) =>
    onDraft(markPaymentFieldOwn({ ...sub, ...next }, field));

  const scopeAside = (field: PaymentSettingsField, label: string) => {
    const scope = paymentSettingsFieldScope(sub, field, workspacePayment);
    return (
      <>
        <span
          className="shrink-0 text-[12px] font-semibold text-muted"
          data-attr={`property-payment-scope-${field}`}
        >
          {paymentSettingsScopeLabel(scope)}
        </span>
        {scope === "own" ? (
          <FactRowReset
            onReset={() => onCommit(resetPaymentFieldToWorkspace(sub, field, workspacePayment))}
            label={`Reset ${label} to the workspace default`}
            title="Back to the workspace default"
            dataAttr={`property-payment-reset-${field}`}
          />
        ) : null}
      </>
    );
  };

  const lateFeesOn = sub.lateFeeEnabled !== false;
  const payer: ServiceFeePayer = sub.serviceFeePayer ?? "resident";
  const coverageCode = sub.serviceFeeWaiverCode ?? "";
  const coverageCodeInvalid = coverageCode.length > 0 && !isProcessingCoverageCodeShape(coverageCode);

  return (
    <PortalSettingsSection title="Rent & fees">
      <div data-attr="property-payment-settings">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Rent due">
          <span className="flex items-center justify-end gap-2">
            {scopeAside("rentDueDayMode", "Rent due")}
            <FieldSingleSelect
              label="Rent due"
              hideLabel
              variant="cell"
              options={RENT_DUE_OPTIONS}
              value={sub.rentDueDayMode ?? "first_of_month"}
              dataAttr="property-payment-rent-due-day"
              onChange={(v) =>
                commitOwn("rentDueDayMode", {
                  rentDueDayMode: v === "last_of_month" ? "last_of_month" : "first_of_month",
                })
              }
            />
          </span>
        </PortalSettingsRow>

        <PortalSettingsRow label="Automatic late fees">
          <span className="flex items-center justify-end gap-2">
            {scopeAside("lateFeeEnabled", "Automatic late fees")}
            <PortalSettingsToggle
              label="Automatic late fees"
              checked={lateFeesOn}
              dataAttr="property-payment-late-fee-enabled"
              onChange={(next) => commitOwn("lateFeeEnabled", { lateFeeEnabled: next })}
            />
          </span>
        </PortalSettingsRow>

        {lateFeesOn ? (
          <>
            <PortalSettingsRow label="Late fee amount">
              <span className="flex items-center justify-end gap-2">
                {scopeAside("lateFeeAmount", "Late fee amount")}
                <span className="relative inline-block w-[118px]">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-muted">
                    $
                  </span>
                  <input
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Late fee amount"
                    value={(sub.lateFeeAmount ?? "50").replace(/^\$/, "").trim()}
                    placeholder="50"
                    data-attr="property-payment-late-fee-amount"
                    onChange={(e) => draftOwn("lateFeeAmount", { lateFeeAmount: sanitizeMoneyInput(e.target.value) })}
                    onBlur={(e) => commitOwn("lateFeeAmount", { lateFeeAmount: sanitizeMoneyInput(e.target.value) })}
                    className="min-h-[36px] w-full rounded-lg border border-border bg-card pl-5 pr-2.5 text-right text-[13.5px] font-semibold tabular-nums text-foreground outline-none focus:border-primary"
                  />
                </span>
              </span>
            </PortalSettingsRow>

            <PortalSettingsRow label="Grace days">
              <span className="flex items-center justify-end gap-2">
                {scopeAside("lateFeeGraceDays", "Grace days")}
                <GraceDaysStepper
                  value={sub.lateFeeGraceDays ?? 5}
                  onChange={(next) => commitOwn("lateFeeGraceDays", { lateFeeGraceDays: next })}
                />
              </span>
            </PortalSettingsRow>
          </>
        ) : null}

        <PortalSettingsRow label="Processing fee paid by">
          <span className="flex items-center justify-end gap-2">
            {scopeAside("serviceFeePayer", "Processing fee paid by")}
            <FieldSingleSelect
              label="Processing fee paid by"
              hideLabel
              variant="cell"
              options={PAYER_OPTIONS}
              value={payer}
              dataAttr="property-payment-fee-payer"
              onChange={(v) =>
                onCommit(
                  markPaymentFieldOwn(
                    resetPaymentFieldToWorkspace(
                      { ...sub, serviceFeePayer: v as ServiceFeePayer },
                      "serviceFeeWaiverCode",
                      workspacePayment,
                    ),
                    "serviceFeePayer",
                  ),
                )
              }
            />
          </span>
        </PortalSettingsRow>

        {payer === "proplane" ? (
          <PortalSettingsRow label="Coverage code">
            <span className="flex flex-col items-end gap-1">
              <span className="flex items-center justify-end gap-2">
                {scopeAside("serviceFeeWaiverCode", "Coverage code")}
                <input
                  style={{ textTransform: "uppercase" }}
                  autoComplete="off"
                  aria-label="Processing coverage code"
                  value={coverageCode}
                  placeholder="Processing coverage code"
                  data-attr="property-payment-coverage-code"
                  onChange={(e) =>
                    draftOwn("serviceFeeWaiverCode", {
                      serviceFeeWaiverCode: normalizeListingPaymentWaiverCode(e.target.value) || undefined,
                    })
                  }
                  onBlur={(e) =>
                    commitOwn("serviceFeeWaiverCode", {
                      serviceFeeWaiverCode: normalizeListingPaymentWaiverCode(e.target.value) || undefined,
                    })
                  }
                  className="min-h-[36px] w-[190px] rounded-lg border border-border bg-card px-2.5 text-[13.5px] font-semibold text-foreground outline-none focus:border-primary"
                />
              </span>
              {coverageCodeInvalid ? (
                <span className="text-[12px] font-semibold text-red-600">
                  {LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID}
                </span>
              ) : null}
            </span>
          </PortalSettingsRow>
        ) : null}
      </PortalSettingsGroup>
      </div>
    </PortalSettingsSection>
  );
}
