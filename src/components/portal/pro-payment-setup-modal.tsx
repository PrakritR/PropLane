"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { openStripeConnectOnboarding } from "@/lib/stripe-connect-onboarding-client";
import {
  DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
  MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT,
  type ManagerManualPaymentSettingsView,
} from "@/lib/manager-manual-payment-settings";
import { normalizeManagerSkuTier, type ManagerSkuTier } from "@/lib/manager-access";
import {
  managerCanSelectManagerAbsorbServiceFee,
  managerCanSelectProplaneServiceFee,
  resolveServiceFeePayerFor,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { loadManagerPaymentWaiverGrantedClient } from "@/lib/manager-subscription-client";
import { stripeSetupStateFromStatus, type StripeSetupState } from "@/lib/stripe-setup-state";

const DEMO_INBOX = "payments+demo-token@prop-lane.space";
const SELECT_ALL_PROPERTIES = "__select_all_properties__";

function draftFromSettings(settings: ManagerManualPaymentSettingsView | null): ManagerManualPaymentSettingsView {
  return settings ?? { ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, paymentInboxAddress: DEMO_INBOX };
}

function feePayerLabel(payer: ServiceFeePayer, skuTier: ManagerSkuTier | null, paymentWaiverGranted: boolean): string {
  if (payer === "resident") return "Resident pays";
  if (payer === "manager") return "I'll cover it";
  if (payer === "proplane" && skuTier === "free" && paymentWaiverGranted) return "PropLane covers it (FREE100)";
  return "PropLane covers it";
}

export function ManagerPaymentSetupModal({
  open,
  onClose,
  propertyOptions,
  presetPropertyIds,
}: {
  open: boolean;
  onClose: () => void;
  portalBase: string;
  propertyOptions: { id: string; label: string }[];
  /** When set, scope the fee table to these ids (e.g. resident detail). */
  presetPropertyIds?: string[];
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [draft, setDraft] = useState<ManagerManualPaymentSettingsView>(() => draftFromSettings(null));
  const [loading, setLoading] = useState(false);
  const [stripeBusy, setStripeBusy] = useState(false);
  const [stripeState, setStripeState] = useState<StripeSetupState>("unlinked");
  const [stripeIssue, setStripeIssue] = useState<string | null>(null);
  const [skuTier, setSkuTier] = useState<ManagerSkuTier | null>(null);
  const [paymentWaiverGranted, setPaymentWaiverGranted] = useState(false);
  const [canEditBankAccount, setCanEditBankAccount] = useState(true);
  const [isCoManagerForPayout, setIsCoManagerForPayout] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [propertyFeePayers, setPropertyFeePayers] = useState<Record<string, ServiceFeePayer | null>>({});
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<string[]>([]);

  const visibleProperties = useMemo(() => {
    if (presetPropertyIds?.length) {
      const allowed = new Set(presetPropertyIds);
      return propertyOptions.filter((property) => allowed.has(property.id));
    }
    return propertyOptions;
  }, [presetPropertyIds, propertyOptions]);

  const lockPropertySelection =
    Boolean(presetPropertyIds?.length === 1) && visibleProperties.length <= 1;

  const propertyIdsKey = useMemo(
    () => visibleProperties.map((property) => property.id).join(","),
    [visibleProperties],
  );

  const loadStripeStatus = useCallback(async () => {
    if (demo) {
      setStripeState("ready");
      setStripeIssue(null);
      return;
    }
    try {
      const res = await fetch("/api/stripe/connect/status", { credentials: "include" });
      const body = (await res.json()) as {
        payoutsEnabled?: boolean;
        chargesEnabled?: boolean;
        transfersEnabled?: boolean;
        paymentReady?: boolean;
        connected?: boolean;
        accountId?: string | null;
        stripeError?: string | null;
        demo?: boolean;
        message?: string;
        canEditBankAccount?: boolean;
        isCoManagerForPayout?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setCanEditBankAccount(false);
        setIsCoManagerForPayout(body.isCoManagerForPayout === true);
        setStripeState("unknown");
        setStripeIssue(body.error ?? "Couldn't check your Stripe status. Try again.");
        return;
      }
      setCanEditBankAccount(body.canEditBankAccount !== false);
      setIsCoManagerForPayout(body.isCoManagerForPayout === true);
      const nextState = stripeSetupStateFromStatus(body);
      setStripeState(nextState);
      setStripeIssue(
        nextState === "unknown"
          ? body.stripeError ?? body.message ?? "Couldn't check your Stripe status. Try again."
          : nextState === "incomplete"
            ? "Finish onboarding (identity + bank details) so resident payments can deposit."
            : null,
      );
    } catch {
      setStripeState("unknown");
      setStripeIssue("Couldn't check your Stripe status. Try again.");
    }
  }, [demo]);

  const loadSettings = useCallback(async () => {
    if (demo) {
      setDraft(draftFromSettings({ ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, paymentInboxAddress: DEMO_INBOX }));
      setPropertyFeePayers(
        Object.fromEntries(visibleProperties.map((property) => [property.id, null] as const)),
      );
      return;
    }
    if (!propertyIdsKey) {
      setPropertyFeePayers({});
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/portal/manager-manual-payment-settings?propertyIds=${encodeURIComponent(propertyIdsKey)}`,
        { credentials: "include" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        propertyServiceFeePayers?: Record<string, ServiceFeePayer | null>;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load payment setup.");
        return;
      }
      setDraft(draftFromSettings(data.settings ?? null));
      setPropertyFeePayers(data.propertyServiceFeePayers ?? {});
    } catch {
      showToast("Could not load payment setup.");
    } finally {
      setLoading(false);
    }
  }, [demo, propertyIdsKey, showToast, visibleProperties]);

  const loadTier = useCallback(async () => {
    if (demo) {
      setSkuTier("pro");
      setPaymentWaiverGranted(false);
      return;
    }
    try {
      const [res, waiver] = await Promise.all([
        fetch("/api/manager/subscription", { credentials: "include" }),
        loadManagerPaymentWaiverGrantedClient(),
      ]);
      setPaymentWaiverGranted(waiver);
      if (!res.ok) return;
      const data = (await res.json()) as { tier?: string | null; paymentWaiverGranted?: boolean };
      setSkuTier(normalizeManagerSkuTier(data.tier ?? null));
      if (data.paymentWaiverGranted === true) setPaymentWaiverGranted(true);
    } catch {
      /* fee controls stay hidden until tier loads */
    }
  }, [demo]);

  useEffect(() => {
    if (!open) return;
    void loadStripeStatus();
    void loadSettings();
    void loadTier();
  }, [open, loadStripeStatus, loadSettings, loadTier]);

  useEffect(() => {
    if (!open) {
      setSelectedPropertyIds([]);
      return;
    }
    if (lockPropertySelection && presetPropertyIds?.[0]) {
      setSelectedPropertyIds([presetPropertyIds[0]]);
      return;
    }
    setSelectedPropertyIds(visibleProperties.map((property) => property.id));
  }, [lockPropertySelection, open, presetPropertyIds, visibleProperties]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => void loadStripeStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, loadStripeStatus]);

  async function persistSettings(
    patch: Partial<ManagerManualPaymentSettingsView> & {
      propertyServiceFeePayers?: Array<{ propertyId: string; serviceFeePayer: ServiceFeePayer | null }>;
    },
    savingId: string,
  ) {
    setSavingKey(savingId);
    if (demo) {
      if (patch.propertyServiceFeePayers?.length) {
        setPropertyFeePayers((prev) => {
          const next = { ...prev };
          for (const row of patch.propertyServiceFeePayers ?? []) {
            next[row.propertyId] = row.serviceFeePayer;
          }
          return next;
        });
      }
      if (patch.serviceFeePayer) {
        setDraft((prev) => draftFromSettings({ ...prev, ...patch, axisPaymentsEnabled: true }));
      }
      showToast("Saved (demo).");
      setSavingKey(null);
      return;
    }
    try {
      const res = await fetch("/api/portal/manager-manual-payment-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          ...patch,
          axisPaymentsEnabled: true,
          receiptAutoMarkEnabled: patch.receiptAutoMarkEnabled ?? draft.receiptAutoMarkEnabled !== false,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        propertyServiceFeePayers?: Record<string, ServiceFeePayer | null>;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not save payment setup.");
        return;
      }
      if (data.settings) {
        setDraft(draftFromSettings({ ...data.settings, axisPaymentsEnabled: true }));
        window.dispatchEvent(new CustomEvent(MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT));
      }
      if (data.propertyServiceFeePayers) {
        setPropertyFeePayers((prev) => ({ ...prev, ...data.propertyServiceFeePayers }));
      }
      showToast("Payment setup saved.");
    } catch {
      showToast("Could not save payment setup.");
    } finally {
      setSavingKey(null);
    }
  }

  async function linkStripe() {
    if (!canEditBankAccount) {
      showToast("Only the property owner (or a co-manager with Bank account access) can change payout bank details.");
      return;
    }
    setStripeBusy(true);
    try {
      await openStripeConnectOnboarding({ showToast });
    } finally {
      setStripeBusy(false);
    }
  }

  const tier = skuTier ?? "free";
  const canSelectManagerAbsorb = managerCanSelectManagerAbsorbServiceFee(tier);
  const canSelectProplane = managerCanSelectProplaneServiceFee(tier, paymentWaiverGranted);
  const showFeePayerSection =
    tier === "pro" || tier === "business" || (tier === "free" && paymentWaiverGranted);
  const accountDefaultPayer = draft.serviceFeePayer ?? (tier === "free" ? "resident" : "proplane");

  const stripeStatus =
    stripeState === "ready"
      ? { label: "Connected", tone: "confirmed" as const }
      : stripeState === "incomplete"
        ? { label: "Finish setup", tone: "pending" as const }
        : stripeState === "unknown"
          ? { label: "Unavailable", tone: "warning" as const }
          : { label: "Not linked", tone: "info" as const };

  const stripeAction =
    stripeState === "ready"
      ? "Manage"
      : stripeState === "incomplete"
        ? busyLabel(stripeBusy, "Finish setup")
        : busyLabel(stripeBusy, "Link Stripe");

  const feePayerOptions = useMemo(
    () =>
      [
        { value: "resident" as const, label: "Resident pays" },
        {
          value: "manager" as const,
          label: "I'll cover it",
          disabled: !canSelectManagerAbsorb,
        },
        ...(canSelectProplane
          ? [{ value: "proplane" as const, label: feePayerLabel("proplane", tier, paymentWaiverGranted) }]
          : []),
      ],
    [canSelectManagerAbsorb, canSelectProplane, paymentWaiverGranted, tier],
  );

  const propertyMultiOptions = useMemo(() => {
    const rows = visibleProperties.map((property) => ({ value: property.id, label: property.label }));
    if (visibleProperties.length <= 1) return rows;
    return [{ value: SELECT_ALL_PROPERTIES, label: "Select all" }, ...rows];
  }, [visibleProperties]);

  const propertySelectionTriggerLabel = useMemo(() => {
    if (selectedPropertyIds.length === 0) return undefined;
    if (
      visibleProperties.length > 1 &&
      selectedPropertyIds.length === visibleProperties.length
    ) {
      return "All properties";
    }
    if (selectedPropertyIds.length === 1) {
      return visibleProperties.find((property) => property.id === selectedPropertyIds[0])?.label;
    }
    return `${selectedPropertyIds.length} properties`;
  }, [selectedPropertyIds, visibleProperties]);

  const propertyCheckboxSelected = useMemo(() => {
    if (visibleProperties.length <= 1) return selectedPropertyIds;
    const allSelected =
      selectedPropertyIds.length === visibleProperties.length && visibleProperties.length > 0;
    return allSelected ? [SELECT_ALL_PROPERTIES, ...selectedPropertyIds] : selectedPropertyIds;
  }, [selectedPropertyIds, visibleProperties.length]);

  const handlePropertySelectionChange = (next: string[]) => {
    const allIds = visibleProperties.map((property) => property.id);
    const includesSelectAll = next.includes(SELECT_ALL_PROPERTIES);
    const wasAllSelected = selectedPropertyIds.length === allIds.length && allIds.length > 0;
    if (includesSelectAll !== wasAllSelected) {
      setSelectedPropertyIds(includesSelectAll ? allIds : []);
      return;
    }
    setSelectedPropertyIds(next.filter((id) => id !== SELECT_ALL_PROPERTIES));
  };

  const effectivePayerForProperty = useCallback(
    (propertyId: string): ServiceFeePayer =>
      resolveServiceFeePayerFor({
        tier,
        managerChoice: accountDefaultPayer,
        propertyChoice: propertyFeePayers[propertyId] ?? null,
        waiverGranted: paymentWaiverGranted,
      }),
    [accountDefaultPayer, paymentWaiverGranted, propertyFeePayers, tier],
  );

  const selectedPropertiesFeeValue = useMemo((): ServiceFeePayer | "" => {
    if (selectedPropertyIds.length === 0) return "";
    const values = selectedPropertyIds.map((propertyId) => effectivePayerForProperty(propertyId));
    const first = values[0];
    if (!values.every((value) => value === first)) return "";
    return first;
  }, [effectivePayerForProperty, selectedPropertyIds]);

  const applyFeeToSelectedProperties = (raw: ServiceFeePayer) => {
    if (selectedPropertyIds.length === 0) {
      showToast("Select at least one property.");
      return;
    }
    if (raw === "manager" && !canSelectManagerAbsorb) return;
    if (raw === "proplane" && !canSelectProplane) return;
    const alreadyApplied =
      raw === accountDefaultPayer &&
      selectedPropertyIds.every((propertyId) => (propertyFeePayers[propertyId] ?? null) === null);
    if (alreadyApplied) return;
    void persistSettings(
      {
        serviceFeePayer: raw,
        propertyServiceFeePayers: selectedPropertyIds.map((propertyId) => ({
          propertyId,
          serviceFeePayer: null,
        })),
      },
      "fee-payer",
    );
  };

  return (
    <Modal
      open={open}
      title="Payment setup"
      onClose={onClose}
      dense
      assistantContext="Payment setup"
      panelClassName="max-w-lg"
    >
      <div className="space-y-4">
        {loading ? <p className="text-sm text-muted">Loading…</p> : null}

        <div
          className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5"
          data-testid="payment-setup-stripe-card"
        >
          <div className="flex min-w-0 items-center gap-2">
            <CreditCard className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="text-sm font-semibold text-foreground">Stripe payouts</span>
            {stripeState !== "unlinked" ? <Badge tone={stripeStatus.tone}>{stripeStatus.label}</Badge> : null}
          </div>
          <button
            type="button"
            onClick={() => void linkStripe()}
            disabled={stripeBusy}
            data-attr="manager-payment-stripe-link"
            className="shrink-0 text-sm font-semibold text-primary hover:underline disabled:opacity-50"
          >
            {stripeAction} →
          </button>
        </div>

        {stripeIssue ? (
          <p className="text-xs leading-relaxed text-[var(--status-pending-fg)]">{stripeIssue}</p>
        ) : (
          <p className="text-xs leading-relaxed text-muted">
            ACH and card checkout only — rent deposits through Stripe Connect.
          </p>
        )}

        {isCoManagerForPayout ? (
          <p className="text-xs leading-relaxed text-muted">
            {canEditBankAccount
              ? "You are updating the property owner's payout bank account."
              : "Payout bank details belong to the property owner."}
          </p>
        ) : null}

        {showFeePayerSection ? (
          <section className="space-y-4">
            {lockPropertySelection ? (
              <p className="text-sm text-foreground">
                <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Property · </span>
                {visibleProperties[0]?.label ?? "Property"}
              </p>
            ) : (
              <CheckboxMultiSelect
                label="Properties"
                options={propertyMultiOptions}
                selected={propertyCheckboxSelected}
                onChange={handlePropertySelectionChange}
                selectionTriggerLabel={propertySelectionTriggerLabel}
                disabled={loading || Boolean(savingKey) || visibleProperties.length === 0}
                emptyLabel="Select properties…"
                searchPlaceholder="Search properties…"
                dataAttr="manager-payment-setup-properties"
              />
            )}

            <FieldSingleSelect
              label="Processing fee paid by"
              value={selectedPropertiesFeeValue}
              options={feePayerOptions}
              placeholder={
                selectedPropertyIds.length > 1 && selectedPropertiesFeeValue === ""
                  ? "Mixed — choose to apply"
                  : "Select…"
              }
              onChange={(next) => applyFeeToSelectedProperties(next as ServiceFeePayer)}
              disabled={loading || selectedPropertyIds.length === 0 || savingKey === "fee-payer"}
              dataAttr="manager-service-fee-payer-select"
            />

            <p className="text-xs leading-relaxed text-muted">
              Processing fee applies to every selected property. Rent still deposits to the owner&apos;s bank either
              way.
            </p>
          </section>
        ) : (
          <p className="text-xs leading-relaxed text-muted">
            On the Free plan, residents cover the processing fee unless your account has the FREE100 waiver or you
            upgrade to Pro or Business.
          </p>
        )}
      </div>
    </Modal>
  );
}

function busyLabel(busy: boolean, label: string) {
  return busy ? "Opening…" : label;
}
