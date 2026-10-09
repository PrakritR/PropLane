"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Check, ExternalLink, Gift, Minus, Pencil, Plus, Tag } from "lucide-react";
import { AdminBillingActionDialog } from "@/components/portal/admin-billing-action-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { formatPacificDate } from "@/lib/pacific-time";
import type { AdminAccountBilling } from "@/lib/admin/admin-account-billing.server";
import { MANAGER_PROPERTY_CAP_OVERRIDE_MAX } from "@/lib/manager-billing-overrides";

/**
 * The manager account editor on the account record page
 * (`admin-account-record-page.tsx`): {@link ManagerBillingCards} (Subscription,
 * Trial & discounts, Limits) and {@link ManagerDangerZoneCard}. Billing folded
 * into Accounts (captain: "combine Billing and Accounts") — a staff member who
 * changes a plan must be using the same control regardless of which list they
 * opened it from, or the two grow different rules for the same write. That is
 * exactly the drift "Admin borrows; it does not invent" exists to prevent.
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

type FeeSnapshot = { adminOverride?: string | null; effectivePayer?: string };

/** `YYYY-MM-DD` of tomorrow, UTC - the earliest trial end the server accepts. */
function tomorrowIso(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** One staff billing write. Returns the sentence to show on failure, or `null` when it landed. */
async function sendBillingChange(
  url: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<{ error: string | null; auditRecorded: boolean }> {
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; auditRecorded?: boolean };
    if (!res.ok) return { error: data.error || fallback, auditRecorded: true };
    return { error: null, auditRecorded: data.auditRecorded !== false };
  } catch {
    return { error: fallback, auditRecorded: true };
  }
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateOnly = (iso: string | null | undefined) =>
  iso ? formatPacificDate(iso, { year: "numeric", month: "short", day: "numeric" }) : "—";
const sentenceCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

type BillingDialog = "plan" | "trial" | "promo" | "comp" | "cap" | null;

/**
 * The `?action=` the Subscribers menu links with (`/admin/axis-users/manager-<id>/billing?action=promo`)
 * mapped to the popup it opens. Anything else opens nothing.
 */
export function billingDialogForAction(action: string | null | undefined): "promo" | "trial" | null {
  if (action === "promo") return "promo";
  if (action === "extend-trial") return "trial";
  return null;
}

/** Whole-number stepper for the property cap. `null` is "no limit"; the first + from there is 1. */
function CapStepper({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  const stepBtn =
    "grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-2" data-attr="admin-billing-cap-stepper">
      <button
        type="button"
        aria-label="Decrease property cap"
        disabled={disabled || value === null || value <= 0}
        onClick={() => onChange(Math.max(0, (value ?? 0) - 1))}
        className={stepBtn}
      >
        <Minus className="size-3.5" aria-hidden />
      </button>
      <span className="min-w-[4.5rem] text-center text-[13.5px] font-semibold tabular-nums text-foreground">
        {value === null ? "No limit" : value}
      </span>
      <button
        type="button"
        aria-label="Increase property cap"
        disabled={disabled || (value ?? 0) >= MANAGER_PROPERTY_CAP_OVERRIDE_MAX}
        onClick={() => onChange(Math.min(MANAGER_PROPERTY_CAP_OVERRIDE_MAX, (value ?? 0) + 1))}
        className={stepBtn}
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Who pays this manager's processing fees. Loaded per record rather than on the accounts list,
 * because it needs the manager's settings AND their plan - two reads each. Saves on change, as it
 * always has; the server is the only truth, so it is re-read after a failed save.
 */
function ProcessingFeesRow({ managerUserId, showToast }: { managerUserId: string; showToast: (m: string) => void }) {
  const [feeOverride, setFeeOverride] = useState<FeeOverrideValue>("inherit");
  const [effectivePayer, setEffectivePayer] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const apply = useCallback((data: FeeSnapshot) => {
    setFeeOverride((data.adminOverride as FeeOverrideValue) ?? "inherit");
    setEffectivePayer(data.effectivePayer ?? "");
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/manager-service-fee?managerUserId=${encodeURIComponent(managerUserId)}`);
    if (!res.ok) return false;
    apply((await res.json()) as FeeSnapshot);
    return true;
  }, [managerUserId, apply]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/manager-service-fee?managerUserId=${encodeURIComponent(managerUserId)}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as FeeSnapshot;
        if (!cancelled) apply(data);
      } catch {
        // Leave the control on "inherit"; saving still works and re-reads the truth.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [managerUserId, apply]);

  const save = async (next: FeeOverrideValue) => {
    setBusy(true);
    const previous = feeOverride;
    setFeeOverride(next);
    try {
      const res = await fetch("/api/admin/manager-service-fee", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // "inherit" is sent as null, which CLEARS the override and returns this manager to the
        // plan-and-choice rule - a different act from pinning "resident".
        body: JSON.stringify({ managerUserId, adminOverride: next === "inherit" ? null : next }),
      });
      const data = (await res.json().catch(() => ({}))) as FeeSnapshot & { error?: string };
      if (!res.ok) {
        if (!(await load().catch(() => false))) setFeeOverride(previous);
        showToast(data.error || "Could not update processing fees.");
        return;
      }
      apply({ ...data, adminOverride: data.adminOverride ?? (next === "inherit" ? null : next) });
      showToast(
        next === "inherit"
          ? "Processing fees follow the manager's own setting again."
          : `Processing fees now charged to ${FEE_OVERRIDE_LABELS[next]}.`,
      );
    } catch {
      if (!(await load().catch(() => false))) setFeeOverride(previous);
      showToast("Could not update processing fees.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <RecordFactRow
        label="Processing fees"
        value={
          <FieldSingleSelect
            label="Who pays this manager's processing fees"
            hideLabel
            value={feeOverride}
            options={FEE_OVERRIDE_OPTIONS}
            disabled={busy}
            onChange={(next) => void save(next as FeeOverrideValue)}
            wrapperClassName="max-w-[16rem]"
            dataAttr="admin-fee-override"
          />
        }
      />
      {/* The NET answer can differ from the selection above: a free-tier manager who chose to
          absorb fees still cannot, and the selection alone would disagree with what the resident
          is actually charged. */}
      {effectivePayer ? (
        <RecordFactRow label="Fees paid by" value={sentenceCase(FEE_PAYER_LABELS[effectivePayer] ?? effectivePayer)} />
      ) : null}
    </>
  );
}

/**
 * The manager's Billing & plan section: Subscription, Trial & discounts, Limits.
 *
 * Plain fact cards with icon actions at each card's top right - no grey block over the values and
 * no explanatory sentence under a field. Every change opens a small popup with a required
 * one-line Reason and one primary naming the outcome, and every one is live: it changes the Stripe
 * subscription or the date/plan the resolver reads, and writes an audit row.
 */
export function ManagerBillingCards({
  row,
  billing,
  billingState,
  onChanged,
  showToast,
  initialAction,
  onActionConsumed,
}: {
  row: ManagerAccountDetailRow;
  billing: AdminAccountBilling | null;
  billingState: "loading" | "ready" | "error";
  /** Re-read the record and the billing after a change landed. */
  onChanged: () => void;
  showToast: (m: string) => void;
  /** The `?action=` from the URL: opens the matching popup once, after billing has loaded. */
  initialAction?: string | null;
  /** Called once the popup was opened, so the page can drop the param. */
  onActionConsumed?: () => void;
}) {
  const [dialog, setDialog] = useState<BillingDialog>(null);
  const currentPlan = normalizeManagerPlan(row.tier);
  const [plan, setPlan] = useState<ManagerPlan>(currentPlan);
  const [trialDate, setTrialDate] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [capDraft, setCapDraft] = useState<number | null | undefined>(undefined);

  const planBlock = billing?.plan;
  const savedCap = billing?.limits.propertyCap ?? null;
  const cap = capDraft === undefined ? savedCap : capDraft;
  const capDirty = capDraft !== undefined && capDraft !== savedCap;
  const complimentary = planBlock?.complimentary ?? false;

  useEffect(() => {
    queueMicrotask(() => setPlan(normalizeManagerPlan(row.tier)));
  }, [row.tier]);

  const open = (which: Exclude<BillingDialog, null>) => {
    if (which === "plan") setPlan(currentPlan);
    if (which === "trial") setTrialDate(planBlock?.trialEndsAt ? planBlock.trialEndsAt.slice(0, 10) : "");
    if (which === "promo") setPromoCode("");
    setDialog(which);
  };

  const deepLinkDialog = billingDialogForAction(initialAction);
  const deepLinkReady = billingState !== "loading";
  useEffect(() => {
    if (!deepLinkDialog || !deepLinkReady) return;
    // Wait for the billing read so Extend trial pre-fills the current end date.
    if (deepLinkDialog === "trial") setTrialDate(planBlock?.trialEndsAt ? planBlock.trialEndsAt.slice(0, 10) : "");
    if (deepLinkDialog === "promo") setPromoCode("");
    setDialog(deepLinkDialog);
    onActionConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkDialog, deepLinkReady]);

  const finish = (message: string, auditRecorded: boolean) => {
    showToast(auditRecorded ? message : `${message} The audit entry could not be written.`);
    setCapDraft(undefined);
    onChanged();
  };

  const submitPlan = async (reason: string) => {
    const r = await sendBillingChange("/api/admin/managers", { id: row.id, tier: plan, reason }, "Could not update plan.");
    if (r.error) return r.error;
    finish(`Plan updated to ${MANAGER_PLAN_OPTIONS.find((o) => o.value === plan)?.label}.`, r.auditRecorded);
    return null;
  };
  const submitTrial = async (reason: string) => {
    const r = await sendBillingChange(
      "/api/admin/manager-billing-overrides",
      { managerUserId: row.id, trialEndsAt: trialDate, reason },
      "Could not extend the trial.",
    );
    if (r.error) return r.error;
    finish(`Trial now ends ${dateOnly(`${trialDate}T12:00:00.000Z`)}.`, r.auditRecorded);
    return null;
  };
  const submitPromo = async (reason: string) => {
    const r = await sendBillingChange(
      "/api/admin/manager-billing-overrides",
      { managerUserId: row.id, promoCode: promoCode.trim(), reason },
      "Could not apply that code.",
    );
    if (r.error) return r.error;
    finish(`Promo code ${promoCode.trim().toUpperCase()} applied.`, r.auditRecorded);
    return null;
  };
  const submitComp = async (reason: string) => {
    const r = await sendBillingChange(
      "/api/admin/manager-billing-overrides",
      { managerUserId: row.id, complimentary: !complimentary, reason },
      "Could not change complimentary status.",
    );
    if (r.error) return r.error;
    finish(complimentary ? "Complimentary removed." : "Account is now complimentary.", r.auditRecorded);
    return null;
  };
  const submitCap = async (reason: string) => {
    const r = await sendBillingChange(
      "/api/admin/manager-billing-overrides",
      { managerUserId: row.id, propertyCap: cap, reason },
      "Could not save the property cap.",
    );
    if (r.error) return r.error;
    finish("Property cap saved.", r.auditRecorded);
    return null;
  };

  const loadingValue = billingState === "loading" ? "…" : "—";

  return (
    <>
      <RecordFactCard
        title="Subscription"
        dataAttr="admin-billing-subscription"
        headerActions={
          <>
            {billing?.stripe.customerUrl ? (
              <PortalIconAction
                icon={ExternalLink}
                label="Open in Stripe"
                data-attr="admin-billing-open-stripe"
                onClick={() => window.open(billing.stripe.customerUrl!, "_blank", "noopener,noreferrer")}
              />
            ) : null}
            <PortalIconAction icon={Pencil} label="Change plan" data-attr="admin-billing-change-plan" onClick={() => open("plan")} />
          </>
        }
      >
        {billingState === "error" ? (
          <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-[var(--status-overdue-fg)]">
            Could not load this account&rsquo;s billing.
          </p>
        ) : (
          <>
            <RecordFactRow label="Plan" value={planBlock?.planLabel ?? loadingValue} />
            <RecordFactRow label="Source" value={planBlock?.sourceLabel ?? loadingValue} />
            <RecordFactRow label="Status" value={planBlock?.status ?? loadingValue} tone={planBlock?.statusTone ?? undefined} />
            <RecordFactRow label="Since" value={dateOnly(planBlock?.since)} />
            {planBlock?.renewsAt ? <RecordFactRow label={planBlock.renewsLabel} value={dateOnly(planBlock.renewsAt)} /> : null}
            <RecordFactRow
              label="Paid to date"
              value={billing ? (billing.paidToDateCents === null ? "—" : money(billing.paidToDateCents)) : loadingValue}
            />
            <RecordFactRow label="Promo" value={planBlock?.promoCode ?? (planBlock ? "None" : loadingValue)} />
            {billing && !billing.stripe.available ? (
              <RecordFactRow label="Stripe" value="Could not be reached" tone="bad" />
            ) : null}
          </>
        )}
      </RecordFactCard>

      <RecordFactCard
        title="Trial & discounts"
        dataAttr="admin-billing-trial-discounts"
        headerActions={
          <>
            <PortalIconAction icon={CalendarPlus} label="Extend trial" data-attr="admin-billing-extend-trial" onClick={() => open("trial")} />
            <PortalIconAction icon={Tag} label="Apply promo code" data-attr="admin-billing-apply-promo" onClick={() => open("promo")} />
            <PortalIconAction
              icon={Gift}
              label={complimentary ? "Remove complimentary" : "Make complimentary"}
              active={complimentary}
              data-attr="admin-billing-complimentary"
              onClick={() => open("comp")}
            />
          </>
        }
      >
        <RecordFactRow
          label="Trial ends"
          value={planBlock ? (planBlock.trialEndsAt ? dateOnly(planBlock.trialEndsAt) : "No trial") : loadingValue}
        />
        <RecordFactRow label="Complimentary" value={planBlock ? (complimentary ? "Yes" : "No") : loadingValue} />
        <RecordFactRow label="Promo" value={planBlock ? (planBlock.promoCode ?? "None") : loadingValue} />
      </RecordFactCard>

      <RecordFactCard
        title="Limits"
        dataAttr="admin-billing-limits"
        headerActions={
          capDirty ? (
            <PortalIconAction
              icon={Check}
              label="Save property cap"
              tone="primary"
              data-attr="admin-billing-cap-save"
              onClick={() => open("cap")}
            />
          ) : null
        }
      >
        <RecordFactRow
          label="Property cap"
          value={billing ? <CapStepper value={cap} onChange={(n) => setCapDraft(n)} /> : loadingValue}
        />
        <ProcessingFeesRow managerUserId={row.id} showToast={showToast} />
      </RecordFactCard>

      <AdminBillingActionDialog
        open={dialog === "plan"}
        title="Change plan"
        submitLabel="Change plan"
        dataAttr="admin-billing-plan-dialog"
        canSubmit={plan !== currentPlan}
        onClose={() => setDialog(null)}
        onSubmit={submitPlan}
      >
        <FieldSingleSelect
          label="Plan"
          value={plan}
          options={MANAGER_PLAN_OPTIONS}
          onChange={(next) => setPlan(next as ManagerPlan)}
          dataAttr="admin-billing-plan-select"
        />
      </AdminBillingActionDialog>

      <AdminBillingActionDialog
        open={dialog === "trial"}
        title="Extend trial"
        submitLabel="Extend trial"
        dataAttr="admin-billing-trial-dialog"
        canSubmit={Boolean(trialDate) && trialDate >= tomorrowIso()}
        onClose={() => setDialog(null)}
        onSubmit={submitTrial}
      >
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-foreground" htmlFor="admin-billing-trial-date">
            Trial ends
          </label>
          <DateField id="admin-billing-trial-date" value={trialDate} min={tomorrowIso()} onChange={setTrialDate} />
        </div>
      </AdminBillingActionDialog>

      <AdminBillingActionDialog
        open={dialog === "promo"}
        title="Apply promo code"
        submitLabel="Apply code"
        dataAttr="admin-billing-promo-dialog"
        canSubmit={promoCode.trim().length > 0}
        onClose={() => setDialog(null)}
        onSubmit={submitPromo}
      >
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-foreground" htmlFor="admin-billing-promo-code">
            Promo code
          </label>
          <Input
            id="admin-billing-promo-code"
            value={promoCode}
            maxLength={64}
            autoComplete="off"
            className="uppercase"
            onChange={(e) => setPromoCode(e.target.value.replace(/\s+/g, ""))}
            data-attr="admin-billing-promo-code"
          />
        </div>
      </AdminBillingActionDialog>

      <AdminBillingActionDialog
        open={dialog === "comp"}
        title={complimentary ? "Remove complimentary" : "Make complimentary"}
        submitLabel={complimentary ? "Remove complimentary" : "Make complimentary"}
        dataAttr="admin-billing-comp-dialog"
        onClose={() => setDialog(null)}
        onSubmit={submitComp}
      />

      <AdminBillingActionDialog
        open={dialog === "cap"}
        title="Property cap"
        submitLabel={cap === null ? "Follow the plan" : `Set cap to ${cap}`}
        dataAttr="admin-billing-cap-dialog"
        onClose={() => setDialog(null)}
        onSubmit={submitCap}
      >
        <RecordFactRow label="New cap" value={cap === null ? "No limit" : String(cap)} />
      </AdminBillingActionDialog>
    </>
  );
}

/**
 * Enable/disable and delete for one manager account — the "Danger zone" card
 * on the account record page (C165). Split out of the former combined
 * `ManagerAccountDetail` so it renders as its own card, separate from
 * {@link ManagerPlanBillingCard}.
 */
export function ManagerDangerZoneCard({
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

  const [toggleOpen, setToggleOpen] = useState(false);

  /** Disable / enable needs a reason, which the audit trail keeps. Returns an error sentence, or null once it landed. */
  const submitToggle = async (reason: string): Promise<string | null> => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/managers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, active: !row.active, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; auditRecorded?: boolean };
      if (!res.ok) return data.error || "Could not update account.";
      const landed = row.active ? "Manager account disabled." : "Manager account enabled.";
      showToast(data.auditRecorded === false ? `${landed} The audit entry could not be written.` : landed);
      onRefresh();
      return null;
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
    <div className="flex flex-wrap items-center gap-2 px-4 py-4">
      <Button
        type="button"
        variant="outline"
        className={`rounded-full ${row.active ? "border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]" : ""}`}
        onClick={() => setToggleOpen(true)}
        disabled={busy}
      >
        {busy && !confirmDelete ? "Updating…" : row.active ? "Disable account" : "Enable account"}
      </Button>
      <AdminBillingActionDialog
        open={toggleOpen}
        title={row.active ? "Disable account" : "Enable account"}
        submitLabel={row.active ? "Disable account" : "Enable account"}
        dataAttr="admin-manager-active-dialog"
        onClose={() => setToggleOpen(false)}
        onSubmit={submitToggle}
      />
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
  );
}
