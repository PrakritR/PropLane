"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { parseSanitizedInteger, sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import {
  persistManagerListingSubmission,
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import {
  useFlushSettingsAutosaveOnUnmount,
  useReportSettingsSaveStatus,
} from "@/components/portal/settings-save-status-context";

export type PaymentListingLateFeeHandle = {
  saveIfDirty: () => Promise<boolean>;
};

const GRACE_MIN_DAYS = 0;
const GRACE_MAX_DAYS = 30;

function clampGraceDays(n: number): number {
  return Math.min(GRACE_MAX_DAYS, Math.max(GRACE_MIN_DAYS, Math.round(n)));
}

function LateFeeGraceStepper({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  const commit = (n: number) => {
    if (!Number.isFinite(n)) return;
    onChange(clampGraceDays(n));
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label="Decrease grace days"
        disabled={disabled || value <= GRACE_MIN_DAYS}
        onClick={() => commit(value - 1)}
        data-attr="payment-late-fee-grace-days-decrement"
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
        disabled={disabled}
        data-attr="payment-late-fee-grace-days"
        onChange={(e) => commit(parseSanitizedInteger(e.target.value, value))}
        className="h-8 w-14 rounded-lg border border-border bg-card text-center text-sm font-semibold tabular-nums text-foreground [appearance:textfield] focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label="Increase grace days"
        disabled={disabled || value >= GRACE_MAX_DAYS}
        onClick={() => commit(value + 1)}
        data-attr="payment-late-fee-grace-days-increment"
        className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function LateFeeAmountInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (raw: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-block w-[118px]">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-muted">
        $
      </span>
      <input
        inputMode="decimal"
        autoComplete="off"
        aria-label="Late fee amount"
        value={value}
        placeholder="50"
        disabled={disabled}
        data-attr="payment-late-fee-amount"
        onChange={(e) => onChange(sanitizeMoneyInput(e.target.value))}
        className="min-h-[36px] w-full rounded-lg border border-border bg-card pl-5 pr-2.5 text-right text-[13.5px] font-semibold tabular-nums text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
    </span>
  );
}

type LateFeeBaseline = {
  amount: string;
  graceDays: number;
  saveTarget: ManagerPropertySaveTarget;
  sub: ManagerListingSubmissionV1;
};

/**
 * Per-listing late fee amount and grace days, scoped to one house.
 * Account-wide Late fee notices stays on the rent-reminder panel.
 */
export const PaymentListingLateFeeSettings = forwardRef<
  PaymentListingLateFeeHandle,
  {
    propertyOptions: { id: string; label: string }[];
    initialPropertyId?: string;
  }
>(function PaymentListingLateFeeSettings({ propertyOptions, initialPropertyId }, ref) {
  const { userId: managerUserId } = useManagerUserId();
  const { showToast } = useAppUi();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const demo = isDemoModeActive();
  const [propertyId, setPropertyId] = useState("");
  const [amount, setAmount] = useState("50");
  const [graceDays, setGraceDays] = useState(5);
  const [baseline, setBaseline] = useState<LateFeeBaseline | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const firstOptionId = propertyOptions[0]?.id ?? "";
  useEffect(() => {
    const preferred = initialPropertyId?.trim() || firstOptionId;
    setPropertyId((current) => {
      if (current && propertyOptions.some((option) => option.id === current)) return current;
      return preferred;
    });
  }, [firstOptionId, initialPropertyId, propertyOptions]);

  useEffect(() => {
    if (!propertyId || !managerUserId) {
      setAmount("50");
      setGraceDays(5);
      setBaseline(null);
      setLoaded(true);
      return;
    }
    const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
    if (!hit) {
      setAmount("50");
      setGraceDays(5);
      setBaseline(null);
      setLoaded(true);
      return;
    }
    const nextAmount = (hit.sub.lateFeeAmount ?? "50").replace(/^\$/, "").trim() || "50";
    const nextGrace = clampGraceDays(Number(hit.sub.lateFeeGraceDays ?? 5) || 5);
    setAmount(nextAmount);
    setGraceDays(nextGrace);
    setBaseline({
      amount: nextAmount,
      graceDays: nextGrace,
      saveTarget: hit.saveTarget,
      sub: hit.sub,
    });
    setLoaded(true);
  }, [managerUserId, propertyId]);

  const isDirty =
    baseline != null && (amount !== baseline.amount || graceDays !== baseline.graceDays);

  const save = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!isDirty || !baseline || !managerUserId) return true;
      setSaving(true);
      reportSaveStatus({ type: "start" });
      try {
        const next: ManagerListingSubmissionV1 = {
          ...baseline.sub,
          lateFeeAmount: sanitizeMoneyInput(amount) || "50",
          lateFeeGraceDays: clampGraceDays(graceDays),
        };
        const ok = demo
          ? persistManagerListingSubmission(baseline.saveTarget, managerUserId, next)
          : await persistManagerListingSubmissionOnServer(baseline.saveTarget, managerUserId, next);
        if (!ok) throw new Error("Could not save late fee.");
        setBaseline({
          amount: next.lateFeeAmount ?? "50",
          graceDays: next.lateFeeGraceDays ?? 5,
          saveTarget: baseline.saveTarget,
          sub: next,
        });
        if (!options?.silent) showToast("Late fee saved.");
        reportSaveStatus({ type: "success" });
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not save late fee.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [amount, baseline, demo, graceDays, isDirty, managerUserId, reportSaveStatus, showToast],
  );

  const saveIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    return save({ silent: true });
  }, [isDirty, save]);

  useImperativeHandle(ref, () => ({ saveIfDirty }), [saveIfDirty]);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isDirty || saving) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void save({ silent: true });
    }, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [isDirty, save, saving]);

  useFlushSettingsAutosaveOnUnmount(save, isDirty);

  const selectProperty = async (next: string) => {
    if (next === propertyId) return;
    if (isDirty) {
      const ok = await save({ silent: true });
      if (!ok) return;
    }
    setPropertyId(next);
  };

  const disabled = saving || propertyOptions.length === 0 || !baseline;

  return (
    <>
      <PortalSettingsRow className="flex-wrap items-start gap-y-2.5" label="Applies to">
        {propertyOptions.length === 0 ? (
          <span className="text-sm text-muted">No houses yet</span>
        ) : (
          <FieldSingleSelect
            hideLabel
            label="Applies to"
            value={propertyId}
            options={propertyOptions.map((option) => ({ value: option.id, label: option.label }))}
            onChange={(next) => void selectProperty(next)}
            disabled={saving}
            dataAttr="payment-late-fee-applies-to"
          />
        )}
      </PortalSettingsRow>
      <PortalSettingsRow label="Late fee amount">
        <LateFeeAmountInput value={amount} onChange={setAmount} disabled={disabled} />
      </PortalSettingsRow>
      <PortalSettingsRow label="Grace days">
        <LateFeeGraceStepper value={graceDays} onChange={setGraceDays} disabled={disabled} />
      </PortalSettingsRow>
      {propertyId && managerUserId && loaded && !baseline ? (
        <p className="px-4 py-3 text-sm text-muted">Could not load late fees for that property.</p>
      ) : null}
    </>
  );
});
