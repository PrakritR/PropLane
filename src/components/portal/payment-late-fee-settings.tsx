"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  parseSanitizedInteger,
  parseSanitizedMoneyNumber,
  sanitizeMoneyInput,
} from "@/lib/listing-form-inputs";
import {
  persistManagerListingSubmission,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import {
  useFlushSettingsAutosaveOnUnmount,
  useReportSettingsSaveStatus,
} from "@/components/portal/settings-save-status-context";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";

export type PaymentListingLateFeeHandle = {
  saveIfDirty: () => Promise<boolean>;
};

const GRACE_MIN_DAYS = 1;
const GRACE_MAX_DAYS = 30;

function clampGraceDays(n: number): number {
  return Math.min(GRACE_MAX_DAYS, Math.max(GRACE_MIN_DAYS, Math.round(n)));
}

function lateFeeToastMessage(amount: string, count: number, allPropertiesMode: boolean, workspaceName?: string): string {
  if (count <= 1) return "Late fee saved.";
  const base = `Late fee $${amount} saved on ${count} properties`;
  return allPropertiesMode && workspaceName ? `${base} in ${workspaceName}` : `${base}.`;
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
};

/**
 * Late fee amount + grace days, driven entirely by the Payments settings
 * module's own scope bar (PLAN-0920-0845 phase E) — there is no internal
 * "Applies to" picker any more (AGENTS.md § Icon chrome: one property control
 * per module chrome). `useSettingsPropertyScope().propertyIds` is the
 * explicit pick; an empty pick means "every property in `propertyOptions`" —
 * the effective workspace's full list the caller already resolved — which is
 * itself empty only for a workspace with no houses in it yet.
 *
 * Late fee has no workspace/account rung to fall back to (captain's build
 * note: it "lives on each listing"), so a workspace-wide edit here fans the
 * SAME value out to every listing the bar resolved, in one write, through
 * `POST /api/portal/manager-listing-late-fee-settings` — which re-authorizes
 * every id server-side and refuses the whole batch if any one fails.
 */
export const PaymentListingLateFeeSettings = forwardRef<
  PaymentListingLateFeeHandle,
  {
    /** Every property the "all properties" bucket fans a write out to — the
        module's already-resolved effective-workspace list. */
    propertyOptions: { id: string; label: string }[];
    /** For the "… in <name>" toast/tag when nothing is explicitly selected. */
    workspaceName?: string;
    workspaceId?: string;
  }
>(function PaymentListingLateFeeSettings({ propertyOptions, workspaceName, workspaceId }, ref) {
  const { userId: managerUserId } = useManagerUserId();
  const { showToast } = useAppUi();
  const reportSaveStatus = useReportSettingsSaveStatus();
  const demo = isDemoModeActive();
  const { propertyIds: selectedIds, reportSource } = useSettingsPropertyScope();

  const [amount, setAmount] = useState("50");
  const [graceDays, setGraceDays] = useState(5);
  const [baseline, setBaseline] = useState<LateFeeBaseline | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const allPropertiesMode = selectedIds.length === 0;
  const targetIds = useMemo(
    () => (allPropertiesMode ? propertyOptions.map((option) => option.id) : selectedIds),
    [allPropertiesMode, propertyOptions, selectedIds],
  );
  const anchorId = targetIds[0] ?? "";
  const isEmptyWorkspace = targetIds.length === 0;

  useEffect(() => {
    reportSource("late-fee-settings", isEmptyWorkspace ? undefined : "property");
  }, [reportSource, isEmptyWorkspace]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!anchorId || !managerUserId) {
        setAmount("50");
        setGraceDays(5);
        setBaseline(null);
        setLoaded(true);
        return;
      }
      setLoaded(false);
      let hit = resolveManagerListingSubmissionForPropertyId(managerUserId, anchorId);
      if (!hit && !demo) {
        // Cache miss — hydrate this manager's listing cache from the server
        // (the same property-records read every other portfolio screen syncs
        // from) and try once more before giving up on this property.
        await syncPropertyPipelineFromServer({ userId: managerUserId });
        if (cancelled) return;
        hit = resolveManagerListingSubmissionForPropertyId(managerUserId, anchorId);
      }
      if (cancelled) return;
      if (!hit) {
        setAmount("50");
        setGraceDays(5);
        setBaseline(null);
        setLoaded(true);
        return;
      }
      const nextAmount = sanitizeMoneyInput(hit.sub.lateFeeAmount ?? "50") || "50";
      const nextGrace = clampGraceDays(Number(hit.sub.lateFeeGraceDays ?? 5) || 5);
      setAmount(nextAmount);
      setGraceDays(nextGrace);
      setBaseline({ amount: nextAmount, graceDays: nextGrace });
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [anchorId, managerUserId, demo]);

  const isDirty =
    baseline != null && (amount !== baseline.amount || graceDays !== baseline.graceDays);
  const amountReady = parseSanitizedMoneyNumber(amount) > 0;
  const pendingSave = isDirty && amountReady && targetIds.length > 0;

  const save = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!pendingSave || !managerUserId) return true;
      savingRef.current = true;
      setSaving(true);
      reportSaveStatus({ type: "start" });
      try {
        const nextAmount = sanitizeMoneyInput(amount);
        const nextGrace = clampGraceDays(graceDays);
        let listingsUpdated = targetIds.length;
        if (demo) {
          for (const id of targetIds) {
            const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, id);
            if (hit) {
              persistManagerListingSubmission(hit.saveTarget, managerUserId, {
                ...hit.sub,
                lateFeeAmount: nextAmount,
                lateFeeGraceDays: nextGrace,
              });
            }
          }
        } else {
          const res = await fetch("/api/portal/manager-listing-late-fee-settings", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              propertyIds: targetIds,
              lateFeeAmount: nextAmount,
              lateFeeGraceDays: nextGrace,
              ...(workspaceId ? { workspaceId } : {}),
            }),
          });
          const data = (await res.json().catch(() => ({}))) as { listingsUpdated?: number; error?: string };
          if (!res.ok) throw new Error(data.error ?? "Could not save late fee.");
          listingsUpdated = data.listingsUpdated ?? targetIds.length;
        }
        setBaseline({ amount: nextAmount, graceDays: nextGrace });
        setAmount((current) => (current === amount ? nextAmount : current));
        setGraceDays((current) => (current === graceDays ? nextGrace : current));
        if (!options?.silent) {
          showToast(lateFeeToastMessage(nextAmount, listingsUpdated, allPropertiesMode, workspaceName));
        }
        reportSaveStatus({ type: "success" });
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not save late fee.";
        showToast(message);
        reportSaveStatus({ type: "failure", reason: message });
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [amount, allPropertiesMode, demo, graceDays, managerUserId, pendingSave, reportSaveStatus, showToast, targetIds, workspaceId, workspaceName],
  );

  const saveIfDirty = useCallback(async (): Promise<boolean> => {
    if (!pendingSave) return true;
    return save({ silent: true });
  }, [pendingSave, save]);

  useImperativeHandle(ref, () => ({ saveIfDirty }), [saveIfDirty]);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!pendingSave) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      if (savingRef.current) return;
      // A single-property autosave stays silent (per-keystroke, would spam a
      // toast); a fan-out to more than one listing is consequential enough
      // that autosave still confirms it, since there is no separate explicit
      // "Save" action for this scope-driven panel.
      void save({ silent: targetIds.length <= 1 });
    }, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [pendingSave, save, targetIds.length]);

  useFlushSettingsAutosaveOnUnmount(save, pendingSave);

  const unavailable = isEmptyWorkspace || !baseline;
  const disabled = saving || unavailable;

  return (
    <>
      <PortalSettingsRow label="Late fee amount">
        {isEmptyWorkspace ? (
          <span className="text-sm text-muted" data-attr="payment-late-fee-empty-workspace">
            No properties in this workspace yet
          </span>
        ) : (
          <LateFeeAmountInput value={amount} onChange={setAmount} disabled={unavailable} />
        )}
      </PortalSettingsRow>
      <PortalSettingsRow label="Grace days">
        <LateFeeGraceStepper value={graceDays} onChange={setGraceDays} disabled={disabled} />
      </PortalSettingsRow>
      {anchorId && managerUserId && loaded && !baseline ? (
        <p className="px-4 py-3 text-sm text-muted">Could not load late fees for that property.</p>
      ) : null}
    </>
  );
});
