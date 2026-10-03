"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";

type SavedMethod = { id: string; type: "card" | "us_bank_account"; label: string; isDefault: boolean };

type AutopayState = {
  managerAllowsAutopay: boolean;
  enabled: boolean;
  paymentMethodId: string | null;
  hasSavedMethod: boolean;
  savedMethods: SavedMethod[];
  defaultMethod: SavedMethod | null;
  runDaysBeforeDue: number;
  nextScheduledCharge: string | null;
  failedRun: { chargeId: string; chargeTitle: string; failureReason: string } | null;
};

const RUN_DAYS_OPTIONS = [
  { value: "0", label: "On the due date" },
  { value: "1", label: "1 day before" },
  { value: "2", label: "2 days before" },
  { value: "3", label: "3 days before" },
  { value: "4", label: "4 days before" },
  { value: "5", label: "5 days before" },
];

/**
 * The resident Payments "Autopay" card — one On/Off row, then Pays with / Runs
 * / Next payment when on, a locked "Add a bank or card first" control with no
 * saved method, and a decline banner when the last run failed. Rendered above
 * the charges list; not rendered at all when the manager has turned autopay
 * off (`managerAllowsAutopay: false`).
 */
export function ResidentAutopayCard({
  onManagePaymentMethods,
  onPayChargeNow,
  refreshToken,
}: {
  onManagePaymentMethods: () => void;
  onPayChargeNow: (chargeId: string) => void;
  /** Bump this to force a reload (e.g. after a payment method is added). */
  refreshToken?: number;
}) {
  const [state, setState] = useState<AutopayState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/resident/autopay", { credentials: "include", cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as Partial<AutopayState> & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not load autopay settings.");
        return;
      }
      setState({
        managerAllowsAutopay: data.managerAllowsAutopay ?? true,
        enabled: data.enabled ?? false,
        paymentMethodId: data.paymentMethodId ?? null,
        hasSavedMethod: data.hasSavedMethod ?? false,
        savedMethods: data.savedMethods ?? [],
        defaultMethod: data.defaultMethod ?? null,
        runDaysBeforeDue: data.runDaysBeforeDue ?? 0,
        nextScheduledCharge: data.nextScheduledCharge ?? null,
        failedRun: data.failedRun ?? null,
      });
      setError(null);
    } catch {
      setError("Could not load autopay settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const save = useCallback(
    async (patch: { enabled?: boolean; paymentMethodId?: string | null; runDaysBeforeDue?: number }) => {
      if (!state) return;
      setSaving(true);
      try {
        const res = await fetch("/api/resident/autopay", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: patch.enabled ?? state.enabled,
            paymentMethodId: patch.paymentMethodId ?? state.paymentMethodId ?? undefined,
            runDaysBeforeDue: patch.runDaysBeforeDue ?? state.runDaysBeforeDue,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<AutopayState> & { error?: string };
        if (!res.ok) {
          setError(data.error ?? "Could not save autopay settings.");
          return;
        }
        setError(null);
        setState((prev) =>
          prev
            ? {
                ...prev,
                enabled: data.enabled ?? prev.enabled,
                paymentMethodId: data.paymentMethodId ?? prev.paymentMethodId,
                runDaysBeforeDue: data.runDaysBeforeDue ?? prev.runDaysBeforeDue,
                nextScheduledCharge: data.nextScheduledCharge ?? prev.nextScheduledCharge,
              }
            : prev,
        );
      } catch {
        setError("Could not save autopay settings.");
      } finally {
        setSaving(false);
      }
    },
    [state],
  );

  const methodOptions = useMemo(
    () => (state?.savedMethods ?? []).map((m) => ({ value: m.id, label: m.label })),
    [state?.savedMethods],
  );

  if (loading || !state) return null;
  if (!state.managerAllowsAutopay) return null;

  const method = state.savedMethods.find((m) => m.id === (state.paymentMethodId ?? state.defaultMethod?.id ?? "")) ?? state.defaultMethod;

  return (
    <section
      className="rounded-2xl border border-border bg-card px-4 py-3.5"
      data-testid="resident-autopay-card"
      data-attr="resident-autopay-card"
      data-jr-autopay
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-foreground">Autopay</h3>
        <FieldSingleSelect
          label="Autopay"
          hideLabel
          // A compact control on the right, like the studio — not a full-width bar.
          wrapperClassName="w-28 shrink-0"
          value={state.enabled ? "on" : "off"}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onChange={(next) => {
            const enabled = next === "on";
            // On with no saved method asks for one first.
            if (enabled && !state.hasSavedMethod) {
              onManagePaymentMethods();
              return;
            }
            setState((prev) => (prev ? { ...prev, enabled } : prev));
            void save({ enabled });
          }}
          disabled={saving}
          dataAttr="resident-autopay-toggle"
        />
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-sm text-muted">Pays with</span>
        {state.enabled && state.hasSavedMethod ? (
          <FieldSingleSelect
            label="Pays with"
            hideLabel
            value={state.paymentMethodId ?? state.defaultMethod?.id ?? ""}
            options={methodOptions}
            placeholder="Select…"
            onChange={(next) => {
              setState((prev) => (prev ? { ...prev, paymentMethodId: next } : prev));
              void save({ paymentMethodId: next });
            }}
            disabled={saving}
            dataAttr="resident-autopay-method"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground" data-attr="resident-autopay-method-label">
            {method?.label ?? "None saved"}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={onManagePaymentMethods}
          data-attr="resident-autopay-add-method"
        >
          {state.hasSavedMethod ? "Change" : "Add payment method"}
        </Button>
      </div>

      {state.enabled ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-sm text-muted">Runs</span>
            <FieldSingleSelect
              label="Runs"
              hideLabel
              value={String(state.runDaysBeforeDue)}
              options={RUN_DAYS_OPTIONS}
              onChange={(next) => {
                const runDaysBeforeDue = Number(next);
                setState((prev) => (prev ? { ...prev, runDaysBeforeDue } : prev));
                void save({ runDaysBeforeDue });
              }}
              disabled={saving}
              dataAttr="resident-autopay-run-days"
            />
          </div>

          {state.nextScheduledCharge ? (
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
              <span className="text-sm text-muted">Next payment</span>
              <span className="text-sm font-bold text-foreground" data-attr="resident-autopay-next-charge">
                {state.nextScheduledCharge}
              </span>
            </div>
          ) : null}
        </>
      ) : null}

      {state.failedRun ? (
        <div
          className="mt-3 space-y-2 rounded-xl border border-[color-mix(in_srgb,var(--status-overdue-fg)_30%,transparent)] bg-[var(--status-overdue-bg)] px-3 py-3"
          data-testid="resident-autopay-failed-banner"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-[var(--status-overdue-fg)]">
              Autopay could not pay {state.failedRun.chargeTitle}
            </span>
            <Badge tone="danger">Declined</Badge>
          </div>
          <p className="text-xs text-[var(--status-overdue-fg)]">{state.failedRun.failureReason} Nothing was charged.</p>
          <div className="flex items-center gap-2 pt-0.5">
            <Button
              variant="primary"
              onClick={() => onPayChargeNow(state.failedRun!.chargeId)}
              data-attr="resident-autopay-pay-now"
            >
              Pay now
            </Button>
            <Button variant="outline" onClick={onManagePaymentMethods} data-attr="resident-autopay-change-method">
              Change method
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
