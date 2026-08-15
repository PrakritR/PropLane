"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  LISTING_FEE_PRESETS,
  applyListingFeesToSubmission,
  cadenceLabel,
  emptyCustomListingFeeRow,
  listingFeeCadence,
  listingFeeWizardFieldKey,
  listingFeesForWizard,
  normalizeListingFeeRow,
  type ListingFeeCadence,
  type ListingFeePresetId,
  type ListingFeeRow,
} from "@/lib/listing-fees";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { sanitizeMoneyInput, sanitizePlaceNameInput } from "@/lib/listing-form-inputs";

const PRESET_META = new Map(LISTING_FEE_PRESETS.map((p) => [p.presetId, p]));

const ACTION_BTN =
  "h-10 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground shadow-sm hover:bg-muted/40";
const REMOVE_BTN = `${ACTION_BTN} shrink-0 border-rose-200 text-rose-800`;

function FieldLabel({ children, required, hint }: { children: ReactNode; required?: boolean; hint?: string }) {
  return (
    <div className="mb-1.5 space-y-0.5">
      <span className="text-sm font-semibold text-foreground">
        {children}
        {required ? <span className="text-rose-600"> *</span> : null}
      </span>
      {hint ? <p className="text-xs leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

function StepFieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs font-medium text-rose-700">{msg}</p>;
}

function FeeCard({
  title,
  subtitle,
  expanded,
  onToggle,
  onRemove,
  children,
}: {
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <p className="truncate text-xs text-muted">{subtitle}</p>
        </button>
        <Button type="button" variant="outline" className={REMOVE_BTN} onClick={onRemove}>
          Remove
        </Button>
      </div>
      {expanded ? <div className="border-t border-border p-3">{children}</div> : null}
    </div>
  );
}

type Props = {
  sub: ManagerListingSubmissionV1;
  setSub: React.Dispatch<React.SetStateAction<ManagerListingSubmissionV1>>;
  stepFieldErrors: Record<string, string>;
  clearListingFieldError: (key: string) => void;
  listingItemKey: (kind: string, id: string) => string;
  isListingItemExpanded: (key: string) => boolean;
  toggleListingItem: (key: string) => void;
  expandListingItem: (key: string) => void;
  wizardFieldErrorClass: (hasError: boolean, extra?: string) => string;
};

function feeTitle(row: ListingFeeRow): string {
  if (row.label.trim()) return row.label.trim();
  if (row.presetId && row.presetId !== "custom") return PRESET_META.get(row.presetId)?.defaultLabel ?? "Fee";
  return "Fee";
}

function feeSubtitle(row: ListingFeeRow): string {
  const amt = row.amount.replace(/^\$/, "").trim() || "0";
  return `$${amt} · ${cadenceLabel(listingFeeCadence(row))}`;
}

function legacyFieldKeyForFee(fee: ListingFeeRow): string {
  switch (fee.presetId) {
    case "security_deposit":
      return "securityDeposit";
    case "move_in_fee":
      return "moveInFee";
    case "parking_monthly":
      return "parkingMonthly";
    case "hoa_monthly":
      return "hoaMonthly";
    case "other_monthly":
      return "otherMonthlyFees";
    case "mtm_surcharge":
      return "monthToMonthSurcharge";
    case "custom_lease_surcharge":
      return "customLeaseSurcharge";
    default:
      return listingFeeWizardFieldKey(fee.id);
  }
}

export function ListingFeesEditor({
  sub,
  setSub,
  stepFieldErrors,
  clearListingFieldError,
  listingItemKey,
  isListingItemExpanded,
  toggleListingItem,
  expandListingItem,
  wizardFieldErrorClass,
}: Props) {
  const patchFees = (updater: (rows: ListingFeeRow[]) => ListingFeeRow[]) => {
    setSub((s) => {
      const customs = (s.customFees ?? []).map(normalizeListingFeeRow).filter((f) => !f.presetId || f.presetId === "custom");
      const presets = listingFeesForWizard(s).filter((f) => f.presetId && f.presetId !== "custom");
      const next = updater([...presets, ...customs]);
      return applyListingFeesToSubmission(s, next);
    });
  };

  const setFee = (id: string, patch: Partial<ListingFeeRow>) => {
    patchFees((rows) => rows.map((r) => (r.id === id ? normalizeListingFeeRow({ ...r, ...patch }) : r)));
  };

  const removeFee = (id: string) => patchFees((rows) => rows.filter((r) => r.id !== id));

  const addFee = () => {
    const next = emptyCustomListingFeeRow();
    expandListingItem(listingItemKey("fee", next.id));
    patchFees((rows) => [...rows, next]);
  };

  const rows = (() => {
    const presets = listingFeesForWizard(sub).filter((f) => f.presetId && f.presetId !== "custom");
    const customs = (sub.customFees ?? []).map(normalizeListingFeeRow).filter((f) => !f.presetId || f.presetId === "custom");
    return [...presets, ...customs];
  })();

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Enter 0 for anything you do not charge — it stays off the public listing.</p>
      <div className="space-y-3">
        {rows.map((fee, i) => {
          const isCustom = !fee.presetId || fee.presetId === "custom";
          const fieldKey = listingFeeWizardFieldKey(fee.id);
          const legacyKey = legacyFieldKeyForFee(fee);
          const err = stepFieldErrors[fieldKey] || stepFieldErrors[legacyKey];
          const showDueAtSigning =
            fee.presetId === "security_deposit" || fee.presetId === "move_in_fee" || (isCustom && listingFeeCadence(fee) === "one-time");
          const showCredits = fee.presetId === "holding_deposit";

          return (
            <FeeCard
              key={fee.id}
              title={feeTitle(fee)}
              subtitle={feeSubtitle(fee)}
              expanded={isListingItemExpanded(listingItemKey("fee", fee.id))}
              onToggle={() => toggleListingItem(listingItemKey("fee", fee.id))}
              onRemove={() => removeFee(fee.id)}
            >
              <div data-wizard-field={legacyKey} className="grid gap-3 sm:grid-cols-2">
                <div>
                  <FieldLabel required={isCustom}>{isCustom ? "Fee name" : "Label"}</FieldLabel>
                  <Input
                    value={fee.label}
                    onChange={(e) => {
                      clearListingFieldError(fieldKey);
                      clearListingFieldError(legacyKey);
                      setFee(fee.id, { label: sanitizePlaceNameInput(e.target.value) });
                    }}
                    placeholder={isCustom ? "e.g. Pet fee" : undefined}
                  />
                </div>
                <div>
                  <FieldLabel required={Boolean(PRESET_META.get(fee.presetId as ListingFeePresetId)?.requiredInWizard)}>
                    Amount
                  </FieldLabel>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">$</span>
                    <Input
                      className={wizardFieldErrorClass(Boolean(err), "pl-8")}
                      inputMode="decimal"
                      value={fee.amount.replace(/^\$/, "").trim()}
                      onChange={(e) => {
                        clearListingFieldError(fieldKey);
                        clearListingFieldError(legacyKey);
                        setFee(fee.id, { amount: sanitizeMoneyInput(e.target.value) });
                      }}
                      placeholder={fee.presetId === "holding_deposit" ? "100" : "0"}
                    />
                  </div>
                  <StepFieldError msg={err} />
                </div>
                {isCustom ? (
                  <div className="sm:col-span-2">
                    <FieldLabel>Cadence</FieldLabel>
                    <Select
                      value={listingFeeCadence(fee)}
                      onChange={(e) => {
                        const cadence = e.target.value as ListingFeeCadence;
                        setFee(fee.id, {
                          cadence,
                          frequency: cadence === "monthly" ? "monthly" : "one-time",
                          shortTermOnly: cadence === "nightly" ? true : fee.shortTermOnly,
                        });
                      }}
                    >
                      <option value="one-time">One-time</option>
                      <option value="monthly">Monthly</option>
                      <option value="nightly">Nightly (short-term)</option>
                    </Select>
                  </div>
                ) : (
                  <div className={cn("sm:col-span-2 text-xs text-muted")}>
                    Cadence: {cadenceLabel(listingFeeCadence(fee))}
                    {fee.presetId === "holding_deposit" ? " · Defaults to $100 when blank on the listing." : null}
                  </div>
                )}
                {showDueAtSigning || showCredits ? (
                  <div className="flex flex-wrap gap-4 sm:col-span-2">
                    {showDueAtSigning ? (
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={Boolean(fee.dueAtSigning)}
                          onChange={(e) => setFee(fee.id, { dueAtSigning: e.target.checked })}
                        />
                        Due at lease signing
                      </label>
                    ) : null}
                    {showCredits ? (
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border"
                          checked={fee.creditsTowardSecurity !== false}
                          onChange={(e) => setFee(fee.id, { creditsTowardSecurity: e.target.checked })}
                        />
                        Credits toward security deposit
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </FeeCard>
          );
        })}
      </div>
      <Button type="button" variant="outline" className={ACTION_BTN} onClick={addFee}>
        + Add fee
      </Button>
    </div>
  );
}
