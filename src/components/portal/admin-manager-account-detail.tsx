"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { formatPacificDate, formatPacificDateTime } from "@/lib/pacific-time";
import { MANAGER_PROPERTY_CAP_OVERRIDE_MAX } from "@/lib/manager-billing-overrides";

/**
 * The ONE manager account editor.
 *
 * It is rendered by both admin Accounts (`admin-axis-users-client.tsx`) and admin Billing
 * (`admin-billing-client.tsx`). Billing is a different LIST over the same accounts, not a second
 * account screen — a staff member who changes a plan from the Billing list and a staff member who
 * changes it from Accounts must be using the same control, or the two grow different rules for the
 * same write. That is exactly the drift "Admin borrows; it does not invent" exists to prevent.
 */

export type ManagerAccountDetailRow = {
  id: string;
  /** The RAW stored SKU, which is what the Plan select edits — not the resolved effective plan. */
  tier: string;
  active: boolean;
  joinedAt: string | null;
};

export type ManagerPlan = "free" | "pro" | "business";

const MANAGER_PLAN_OPTIONS: { value: ManagerPlan; label: string }[] = [
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "business", label: "Business" },
];

export function normalizeManagerPlan(tier: string): ManagerPlan {
  const t = tier.toLowerCase();
  if (t === "pro" || t === "business") return t;
  return "free";
}

export function StatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold portal-badge-success">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-accent/30 px-2.5 py-1 text-xs font-semibold text-muted">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden />
      Disabled
    </span>
  );
}

export function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    pro: "portal-badge-info border",
    business: "portal-badge-info border",
    free: "border-border bg-accent/30 text-muted",
  };
  const cls = colors[tier.toLowerCase()] ?? colors.free;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${cls}`}>
      {tier}
    </span>
  );
}

type FeeOverrideValue = "inherit" | "resident" | "manager" | "proplane";

const FEE_OVERRIDE_LABELS: Record<Exclude<FeeOverrideValue, "inherit">, string> = {
  resident: "the resident",
  manager: "the manager",
  proplane: "PropLane",
};

const FEE_OVERRIDE_OPTIONS: { value: FeeOverrideValue; label: string }[] = [
  { value: "inherit", label: "Manager's own setting" },
  { value: "resident", label: "Always resident" },
  { value: "manager", label: "Always manager" },
  { value: "proplane", label: "PropLane absorbs" },
];

const FEE_PAYER_LABELS: Record<string, string> = {
  resident: "the resident",
  manager: "the manager",
  proplane: "PropLane",
};

/**
 * One staff change to who pays a manager's processing fees, as `GET /api/admin/manager-service-fee`
 * returns it (the last ten, newest first). `null` on either side means "manager's own setting".
 */
type FeeOverrideChange = {
  id: string;
  at: string;
  actorEmail: string | null;
  actorUserId: string;
  previousOverride: string | null;
  newOverride: string | null;
  effectiveBefore: string;
  effectiveAfter: string;
  reason: string | null;
};

type FeeSnapshot = { adminOverride?: string | null; effectivePayer?: string; changes?: FeeOverrideChange[] };

function feeOverrideChangeLabel(value: string | null): string {
  if (value === null) return "Manager's own setting";
  return FEE_OVERRIDE_OPTIONS.find((opt) => opt.value === value)?.label ?? value;
}

/**
 * Staff need to know the override is the exception, not the default: PropLane charges exactly what
 * Stripe charges and the launch posture is to let each manager's own Payment setup decide. Shown
 * beside the control so nobody reaches for "PropLane absorbs" as a courtesy.
 */
const FEE_OVERRIDE_HELP_TEXT =
  "PropLane does not mark up processing fees. The launch default is the manager's own setting; set an override only for an agreed exception.";

const FIELD_LABEL = "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted";

type OverridesState = {
  propertyCap: number | null;
  trialEndsAt: string | null;
  complimentary: boolean;
};

const EMPTY_OVERRIDES: OverridesState = { propertyCap: null, trialEndsAt: null, complimentary: false };

/**
 * Staff-only billing overrides for one account.
 *
 * Deliberately a SAVE-with-reason form rather than the fee control's save-on-change select: these
 * are commercial exceptions, and the reason is the part a future reader needs. Each save writes one
 * `audit_log` row per field that actually moved.
 *
 * Only the property cap changes what the product does today. The other two are recorded and shown,
 * and the copy under them says so — telling a staff member a comp switch stops billing when nothing
 * reads it would be worse than not having the switch.
 */
function BillingOverridesEditor({
  managerUserId,
  showToast,
}: {
  managerUserId: string;
  showToast: (m: string) => void;
}) {
  const [saved, setSaved] = useState<OverridesState>(EMPTY_OVERRIDES);
  const [capInput, setCapInput] = useState("");
  const [trialInput, setTrialInput] = useState("");
  const [comp, setComp] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/manager-billing-overrides?managerUserId=${encodeURIComponent(managerUserId)}`,
        );
        const data = (await res.json().catch(() => ({}))) as {
          overrides?: OverridesState;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          // Showing blank controls over a state we could not read invites a staff member to set a
          // value on top of one they cannot see, so say so instead.
          setLoadError(data.error ?? "Could not read this account's overrides.");
          return;
        }
        const overrides = data.overrides ?? EMPTY_OVERRIDES;
        setSaved(overrides);
        setCapInput(overrides.propertyCap === null ? "" : String(overrides.propertyCap));
        setTrialInput(overrides.trialEndsAt ?? "");
        setComp(overrides.complimentary);
      } catch {
        if (!cancelled) setLoadError("Could not read this account's overrides.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [managerUserId]);

  const capDirty = capInput.trim() !== (saved.propertyCap === null ? "" : String(saved.propertyCap));
  const trialDirty = trialInput.trim() !== (saved.trialEndsAt ?? "");
  const compDirty = comp !== saved.complimentary;
  const dirty = capDirty || trialDirty || compDirty;

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/manager-billing-overrides", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          managerUserId,
          // Blank means "follow the plan again", which is a different act from pinning the plan's
          // own number — so it is sent as an explicit null rather than omitted.
          propertyCap: capInput.trim() === "" ? null : capInput.trim(),
          trialEndsAt: trialInput.trim() === "" ? null : trialInput.trim(),
          complimentary: comp,
          reason: reason.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        overrides?: OverridesState;
        auditRecorded?: boolean;
      };
      if (!res.ok) {
        showToast(data.error || "Could not save billing overrides.");
        return;
      }
      const overrides = data.overrides ?? EMPTY_OVERRIDES;
      setSaved(overrides);
      setCapInput(overrides.propertyCap === null ? "" : String(overrides.propertyCap));
      setTrialInput(overrides.trialEndsAt ?? "");
      setComp(overrides.complimentary);
      setReason("");
      showToast(
        data.auditRecorded === false
          ? "Overrides saved, but the audit entry could not be written."
          : "Billing overrides saved.",
      );
    } catch {
      showToast("Could not save billing overrides.");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="w-full rounded-2xl border px-4 py-3 text-sm portal-banner-danger" data-attr="admin-billing-overrides-error">
        {loadError}
      </div>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-border bg-background/60 px-4 py-3" data-attr="admin-billing-overrides">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL} htmlFor={`cap-${managerUserId}`}>
            Property cap
          </label>
          <Input
            id={`cap-${managerUserId}`}
            className="h-9 min-h-0 w-28 rounded-full px-3 py-1.5 text-sm"
            inputMode="numeric"
            value={capInput}
            placeholder="Plan default"
            max={MANAGER_PROPERTY_CAP_OVERRIDE_MAX}
            onChange={(e) => setCapInput(e.target.value)}
            disabled={busy}
            data-attr="admin-billing-override-cap"
          />
          <span className="text-[11px] text-muted">Blank = this plan&rsquo;s own limit.</span>
        </div>

        <div className="flex flex-col gap-1">
          <label className={FIELD_LABEL} htmlFor={`trial-${managerUserId}`}>
            Trial end
          </label>
          <Input
            id={`trial-${managerUserId}`}
            type="date"
            className="h-9 min-h-0 w-44 rounded-full px-3 py-1.5 text-sm"
            value={trialInput}
            onChange={(e) => setTrialInput(e.target.value)}
            disabled={busy}
            data-attr="admin-billing-override-trial"
          />
          <span className="text-[11px] text-muted">Recorded only &mdash; the plan still expires on its own date.</span>
        </div>

        <div className="flex flex-col gap-1">
          <span className={FIELD_LABEL}>Complimentary</span>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={comp}
              onChange={(e) => setComp(e.target.checked)}
              disabled={busy}
              data-attr="admin-billing-override-comp"
            />
            Do not bill this account
          </label>
          <span className="text-[11px] text-muted">Recorded only &mdash; billing does not read it yet.</span>
        </div>

        <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <label className={FIELD_LABEL} htmlFor={`reason-${managerUserId}`}>
            Reason
          </label>
          <Input
            id={`reason-${managerUserId}`}
            className="h-9 min-h-0 rounded-full px-3 py-1.5 text-sm"
            value={reason}
            placeholder="Why this account is an exception"
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            data-attr="admin-billing-override-reason"
          />
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-full px-4 text-xs"
          onClick={() => save()}
          disabled={busy || !dirty}
          data-attr="admin-billing-override-save"
        >
          {busy ? "Saving…" : "Save overrides"}
        </Button>
      </div>
    </div>
  );
}

export function ManagerAccountDetail({
  row,
  onRefresh,
  showToast,
}: {
  row: ManagerAccountDetailRow;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [plan, setPlan] = useState<ManagerPlan>(() => normalizeManagerPlan(row.tier));
  const currentPlan = normalizeManagerPlan(row.tier);
  const planDirty = plan !== currentPlan;

  useEffect(() => {
    queueMicrotask(() => setPlan(normalizeManagerPlan(row.tier)));
  }, [row.tier]);

  // Who pays this manager's processing fees. Loaded per row rather than on the accounts list,
  // because it needs the manager's settings AND their plan — two reads each — and the list route
  // already pages every manager. This editor renders for one expanded row at a time.
  const [feeOverride, setFeeOverride] = useState<FeeOverrideValue>("inherit");
  const [effectivePayer, setEffectivePayer] = useState<string>("");
  const [feeBusy, setFeeBusy] = useState(false);
  // An optional note that rides along with the NEXT change and is stored on its audit row.
  const [feeReason, setFeeReason] = useState("");
  const [feeChanges, setFeeChanges] = useState<FeeOverrideChange[]>([]);

  const applyFeeSnapshot = useCallback((data: FeeSnapshot) => {
    setFeeOverride((data.adminOverride as FeeOverrideValue) ?? "inherit");
    setEffectivePayer(data.effectivePayer ?? "");
    setFeeChanges(Array.isArray(data.changes) ? data.changes : []);
  }, []);

  // The server is the only truth for this control: it is re-read on mount and after any failed
  // save, because a save can have been applied and still answered an error (the audit row could
  // not be written), and restoring the previous selection locally would then show a lie.
  const loadFee = useCallback(async () => {
    const res = await fetch(`/api/admin/manager-service-fee?managerUserId=${encodeURIComponent(row.id)}`);
    if (!res.ok) return false;
    applyFeeSnapshot((await res.json()) as FeeSnapshot);
    return true;
  }, [row.id, applyFeeSnapshot]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/manager-service-fee?managerUserId=${encodeURIComponent(row.id)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as FeeSnapshot;
        if (cancelled) return;
        applyFeeSnapshot(data);
      } catch {
        // Leave the control showing "inherit"; saving still works and re-reads the truth.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id, applyFeeSnapshot]);

  const saveFeeOverride = async (next: FeeOverrideValue) => {
    setFeeBusy(true);
    const previous = feeOverride;
    setFeeOverride(next);
    try {
      const res = await fetch("/api/admin/manager-service-fee", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // "inherit" is sent as null, which CLEARS the override and returns this manager to the
        // plan-and-choice rule — a different act from pinning "resident".
        body: JSON.stringify({
          managerUserId: row.id,
          adminOverride: next === "inherit" ? null : next,
          reason: feeReason.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as FeeSnapshot & { error?: string };
      if (!res.ok) {
        if (!(await loadFee().catch(() => false))) setFeeOverride(previous);
        showToast(data.error || "Could not update processing fees.");
        return;
      }
      applyFeeSnapshot({ ...data, adminOverride: data.adminOverride ?? (next === "inherit" ? null : next) });
      setFeeReason("");
      showToast(
        next === "inherit"
          ? "Processing fees follow the manager's own setting again."
          : `Processing fees now charged to ${FEE_OVERRIDE_LABELS[next]}.`,
      );
    } catch {
      if (!(await loadFee().catch(() => false))) setFeeOverride(previous);
      showToast("Could not update processing fees.");
    } finally {
      setFeeBusy(false);
    }
  };

  const savePlan = async () => {
    if (!planDirty) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/managers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, tier: plan }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Could not update plan." }));
        showToast((error as string) || "Could not update plan.");
        return;
      }
      showToast(`Plan updated to ${plan === "free" ? "Free" : plan === "pro" ? "Pro" : "Business"}.`);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/managers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, active: !row.active }),
      });
      if (!res.ok) {
        showToast("Could not update account.");
        return;
      }
      showToast(row.active ? "Manager account disabled." : "Manager account enabled.");
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/managers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Could not delete account." }));
        showToast((error as string) || "Could not delete account.");
        return;
      }
      showToast("Manager account deleted.");
      onRefresh();
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className={FIELD_LABEL}>Account</p>
        <TierBadge tier={row.tier} />
        <StatusPill active={row.active} />
        {row.joinedAt ? (
          <span className="text-xs text-muted">
            Joined {formatPacificDate(row.joinedAt, { year: "numeric", month: "short", day: "numeric" })}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <p className={FIELD_LABEL}>Plan</p>
        <Select
          className="h-9 min-h-0 w-auto min-w-[8.5rem] rounded-full px-3 py-1.5 text-sm"
          value={plan}
          onChange={(e) => setPlan(e.target.value as ManagerPlan)}
          disabled={busy}
        >
          {MANAGER_PLAN_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex w-full flex-col gap-1.5" data-testid="admin-fee-override">
        <div className="flex flex-wrap items-center gap-2">
          <p className={FIELD_LABEL}>Processing fees</p>
          <Select
            className="h-9 min-h-0 w-auto min-w-[11rem] rounded-full px-3 py-1.5 text-sm"
            value={feeOverride}
            onChange={(e) => void saveFeeOverride(e.target.value as FeeOverrideValue)}
            disabled={feeBusy}
            aria-label="Who pays this manager's processing fees"
          >
            {FEE_OVERRIDE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          {/* Stored on the audit row of the next change; optional, staff-authored. */}
          <Input
            className="h-9 min-h-0 w-auto min-w-[14rem] rounded-full px-3 py-1.5 text-sm"
            value={feeReason}
            onChange={(e) => setFeeReason(e.target.value)}
            maxLength={240}
            placeholder="Reason for the change (optional)"
            aria-label="Reason for changing who pays processing fees"
            disabled={feeBusy}
          />
          {/* The NET answer, which can differ from the selection above: a free-tier manager who
              chose to absorb fees still cannot, and showing only the selection would disagree with
              what the resident is actually charged. */}
          {effectivePayer ? (
            <span className="text-xs text-muted">
              Currently paid by {FEE_PAYER_LABELS[effectivePayer] ?? effectivePayer}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted">{FEE_OVERRIDE_HELP_TEXT}</p>
        {feeChanges.length > 0 ? (
          <div className="text-xs text-muted">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Changes</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {feeChanges.map((change) => (
                <li key={change.id} className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="font-medium text-foreground">{change.actorEmail ?? "Former staff"}</span>
                  <span>{formatPacificDateTime(change.at)}</span>
                  <span>
                    {feeOverrideChangeLabel(change.previousOverride)} → {feeOverrideChangeLabel(change.newOverride)}
                  </span>
                  {change.effectiveBefore !== change.effectiveAfter ? (
                    <span>
                      (paid by {FEE_PAYER_LABELS[change.effectiveBefore] ?? change.effectiveBefore} →{" "}
                      {FEE_PAYER_LABELS[change.effectiveAfter] ?? change.effectiveAfter})
                    </span>
                  ) : null}
                  {change.reason ? <span className="italic">“{change.reason}”</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className={`rounded-full ${row.active ? "border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]" : ""}`}
          onClick={() => toggle()}
          disabled={busy}
        >
          {busy && !confirmDelete && !planDirty ? "Updating…" : row.active ? "Disable account" : "Enable account"}
        </Button>
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-full border px-3 py-1.5 portal-banner-danger">
            <span className="text-xs font-semibold text-rose-800">
              Permanently delete this manager, all properties, residents, payments, and login?
            </span>
            <button
              type="button"
              className="rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              onClick={() => void deleteAccount()}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Yes, delete"}
            </button>
            <button
              type="button"
              className="text-xs font-semibold text-muted hover:text-foreground"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="rounded-full border-rose-200 text-rose-700 hover:bg-[var(--status-overdue-bg)]"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            Delete account
          </Button>
        )}
      </div>

      <div className="ml-auto shrink-0">
        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-full px-4 text-xs"
          onClick={() => savePlan()}
          disabled={busy || !planDirty}
        >
          {busy && planDirty ? "Saving…" : "Save plan"}
        </Button>
      </div>

      {/* Beside Plan and Processing fees, not on a screen of their own: an exception to a plan is
          read together with the plan it excepts. */}
      <BillingOverridesEditor managerUserId={row.id} showToast={showToast} />
    </div>
  );
}
