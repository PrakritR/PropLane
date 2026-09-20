"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, CreditCard } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { isProcessingCoverageCodeShape } from "@/lib/processing-coverage-codes";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import {
  DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
  MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT,
  type ManagerManualPaymentSettingsView,
} from "@/lib/manager-manual-payment-settings";
import { normalizeManagerSkuTier, type ManagerSkuTier } from "@/lib/manager-access";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  PROCESSING_FEE_PROPLANE_PENDING_LABEL,
  SERVICE_FEE_PAYER_OPTION_LABELS,
  SERVICE_FEE_PAYER_SHORT_LABELS,
  managerCanSelectManagerAbsorbServiceFee,
  normalizeListingPaymentWaiverCode,
  processingFeeProplanePendingHelp,
  resolveServiceFeePayerFor,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import {
  loadManagerPaymentWaiverGrantedClient,
  loadManagerSubscriptionTierClient,
} from "@/lib/manager-subscription-client";
import { stripeSetupStateFromStatus, type StripeSetupState } from "@/lib/stripe-setup-state";


function draftFromSettings(settings: ManagerManualPaymentSettingsView | null): ManagerManualPaymentSettingsView {
  return settings ?? { ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS };
}

export function ManagerPaymentSetupPanel({
  active,
  propertyOptions,
  presetPropertyIds,
}: {
  active: boolean;
  propertyOptions: { id: string; label: string }[];
  /** When set, scope the fee table to these ids (e.g. resident detail). */
  presetPropertyIds?: string[];
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const portalBasePath = usePaidPortalBasePath();
  const [draft, setDraft] = useState<ManagerManualPaymentSettingsView>(() => draftFromSettings(null));
  const [loading, setLoading] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [stripeState, setStripeState] = useState<StripeSetupState>("unlinked");
  const [stripeIssue, setStripeIssue] = useState<string | null>(null);
  const [skuTier, setSkuTier] = useState<ManagerSkuTier | null>(null);
  const [paymentWaiverGranted, setPaymentWaiverGranted] = useState<boolean | null>(null);
  const [canEditBankAccount, setCanEditBankAccount] = useState(true);
  const [isCoManagerForPayout, setIsCoManagerForPayout] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [propertyFeePayers, setPropertyFeePayers] = useState<Record<string, ServiceFeePayer | null>>({});
  /*
   * Payment setup is answered once per WORKSPACE (captain, 2026-09-13). The
   * screen used to ask which properties a choice applied to, which let a
   * manager set three of nine houses and leave the rest on whatever they had.
   */
  const [workspaceFeePayers, setWorkspaceFeePayers] = useState<Record<string, ServiceFeePayer | null>>({});
  const [workspaceAutopaySettings, setWorkspaceAutopaySettings] = useState<
    Record<string, { autopayEnabled: boolean; autopayRetryEnabled: boolean }>
  >({});
  const workspaceCtx = useWorkspaces();
  /* Only workspaces the signed-in manager owns can have their payment setup
     changed here; a co-manager's access to someone else's house is unchanged. */
  const ownedWorkspaces = useMemo(
    () => (workspaceCtx?.workspaces ?? []).filter((w) => w.owned),
    [workspaceCtx?.workspaces],
  );
  /* Workspace is the portal top-left switcher (PLAN-0916-1400). This form
     does not carry a second workspace dropdown. */
  const activeWorkspaceId =
    (workspaceCtx?.active?.owned ? workspaceCtx.active.id : "") ||
    ownedWorkspaces[0]?.id ||
    "";
  /*
    PropLane pays is applied only by a code at the moment it is chosen (captain,
    2026-09-14). Picking it holds the select on that answer and opens the code
    field; nothing is saved until the server accepts the code, and the answer
    already in force stays in force. The field asks for a code; it never prints one.
  */
  const [proplanePending, setProplanePending] = useState(false);
  const [waiverCodeDraft, setWaiverCodeDraft] = useState("");
  const [waiverCodeError, setWaiverCodeError] = useState<string | null>(null);

  const cancelProplanePending = useCallback(() => {
    setProplanePending(false);
    setWaiverCodeDraft("");
    setWaiverCodeError(null);
  }, []);

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
      setDraft(draftFromSettings({ ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS }));
      setPropertyFeePayers(
        Object.fromEntries(visibleProperties.map((property) => [property.id, null] as const)),
      );
      setWorkspaceFeePayers({});
      setSettingsLoaded(true);
      return;
    }
    setLoading(true);
    try {
      /*
       * Asked even with no properties yet. The fee now belongs to the WORKSPACE,
       * and a workspace with no homes in it still has a payment setup worth
       * reading — returning early here left a new account showing a blank
       * control it could never fill in.
       */
      const res = await fetch(
        propertyIdsKey
          ? `/api/portal/manager-manual-payment-settings?propertyIds=${encodeURIComponent(propertyIdsKey)}`
          : "/api/portal/manager-manual-payment-settings",
        { credentials: "include" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        propertyServiceFeePayers?: Record<string, ServiceFeePayer | null>;
        workspacePaymentSettings?: Record<
          string,
          { serviceFeePayer?: ServiceFeePayer | null; autopayEnabled?: boolean; autopayRetryEnabled?: boolean }
        >;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load payment setup.");
        return;
      }
      setDraft(draftFromSettings(data.settings ?? null));
      setPropertyFeePayers(data.propertyServiceFeePayers ?? {});
      setWorkspaceFeePayers(
        Object.fromEntries(
          Object.entries(data.workspacePaymentSettings ?? {}).map(([id, value]) => [
            id,
            value?.serviceFeePayer ?? null,
          ]),
        ),
      );
      setWorkspaceAutopaySettings(
        Object.fromEntries(
          Object.entries(data.workspacePaymentSettings ?? {}).map(([id, value]) => [
            id,
            {
              autopayEnabled: value?.autopayEnabled !== false,
              autopayRetryEnabled: value?.autopayRetryEnabled !== false,
            },
          ]),
        ),
      );
      setSettingsLoaded(true);
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
      // Both values come from GET /api/manager/subscription; the shared client
      // coalesces them into ONE request instead of the modal issuing a second.
      const [tier, waiver] = await Promise.all([
        loadManagerSubscriptionTierClient(),
        loadManagerPaymentWaiverGrantedClient(),
      ]);
      setPaymentWaiverGranted(waiver);
      setSkuTier(normalizeManagerSkuTier(tier));
    } catch {
      /* fee controls stay hidden until tier loads */
    }
  }, [demo]);

  useEffect(() => {
    if (!active) {
      setSettingsLoaded(false);
      cancelProplanePending();
      return;
    }
    void loadStripeStatus();
    void loadSettings();
    void loadTier();
  }, [active, loadStripeStatus, loadSettings, loadTier, cancelProplanePending]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => void loadStripeStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, loadStripeStatus]);

  async function persistSettings(
    patch: Partial<ManagerManualPaymentSettingsView> & {
      propertyServiceFeePayers?: Array<{ propertyId: string; serviceFeePayer: ServiceFeePayer | null }>;
      /* A workspace-scoped save: the route re-checks the id against the
         signed-in owner, so this is a scope, never an authorization claim. */
      workspaceId?: string;
      workspaceServiceFeePayer?: ServiceFeePayer | null;
      /* Sent with a `proplane` workspace choice; the route checks it against
         the server-only list and refuses the save without a match. */
      workspaceServiceFeeWaiverCode?: string;
      workspaceAutopayEnabled?: boolean;
      workspaceAutopayRetryEnabled?: boolean;
    },
    savingId: string,
    opts?: {
      /* A refusal the caller shows in place (the code field) instead of a toast. */
      onRefused?: (error: string) => void;
    },
  ): Promise<boolean> {
    if (!settingsLoaded && !demo) {
      showToast("Couldn't read your current payment setup, so nothing was changed. Reopen this window to try again.");
      return false;
    }
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
      if (patch.workspaceId && patch.workspaceServiceFeePayer !== undefined) {
        setWorkspaceFeePayers((prev) => ({ ...prev, [patch.workspaceId!]: patch.workspaceServiceFeePayer ?? null }));
      }
      if (patch.workspaceId && (patch.workspaceAutopayEnabled !== undefined || patch.workspaceAutopayRetryEnabled !== undefined)) {
        setWorkspaceAutopaySettings((prev) => ({
          ...prev,
          [patch.workspaceId!]: {
            autopayEnabled: patch.workspaceAutopayEnabled ?? prev[patch.workspaceId!]?.autopayEnabled ?? true,
            autopayRetryEnabled: patch.workspaceAutopayRetryEnabled ?? prev[patch.workspaceId!]?.autopayRetryEnabled ?? true,
          },
        }));
      }
      if (patch.serviceFeePayer) {
        setDraft((prev) => draftFromSettings({ ...prev, ...patch, axisPaymentsEnabled: true }));
      }
      showToast("Saved (demo).");
      setSavingKey(null);
      return true;
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
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        propertyServiceFeePayers?: Record<string, ServiceFeePayer | null>;
        workspacePaymentSettings?: Record<
          string,
          { serviceFeePayer?: ServiceFeePayer | null; autopayEnabled?: boolean; autopayRetryEnabled?: boolean }
        >;
        error?: string;
      };
      if (!res.ok) {
        const error = data.error ?? "Could not save payment setup.";
        if (opts?.onRefused) opts.onRefused(error);
        else showToast(error);
        return false;
      }
      if (data.settings) {
        setDraft(draftFromSettings({ ...data.settings, axisPaymentsEnabled: true }));
        window.dispatchEvent(new CustomEvent(MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT));
      }
      if (data.propertyServiceFeePayers) {
        setPropertyFeePayers((prev) => ({ ...prev, ...data.propertyServiceFeePayers }));
      }
      if (data.workspacePaymentSettings) {
        setWorkspaceAutopaySettings((prev) => ({
          ...prev,
          ...Object.fromEntries(
            Object.entries(data.workspacePaymentSettings ?? {}).map(([id, value]) => [
              id,
              {
                autopayEnabled: value?.autopayEnabled !== false,
                autopayRetryEnabled: value?.autopayRetryEnabled !== false,
              },
            ]),
          ),
        }));
      }
      showToast("Payment setup saved.");
      return true;
    } catch {
      showToast("Could not save payment setup.");
      return false;
    } finally {
      setSavingKey(null);
    }
  }

  function openPayouts() {
    if (!canEditBankAccount) {
      showToast("Only the property owner (or a co-manager with Bank account access) can change payout bank details.");
      return;
    }
    // Identity, bank and the balance all live on the Payouts page now — this
    // row is a door to it, never its own Stripe popup (PLAN-0920-0853).
    window.location.href = `${portalBasePath}/payments/payouts`;
  }

  const tier = skuTier ?? "free";
  const canSelectManagerAbsorb = managerCanSelectManagerAbsorbServiceFee(tier);
  const showFeePayerSection =
    tier === "pro" || tier === "business" || (tier === "free" && paymentWaiverGranted);
  const accountDefaultPayer = resolveServiceFeePayerFor({
    tier,
    managerChoice: draft.serviceFeePayer,
    adminOverride: draft.adminServiceFeeOverride,
    waiverGranted: paymentWaiverGranted === true,
  });

  // Plain words, never a pill (AGENTS.md § No subtext): "Ready" once payouts
  // can actually go out, "Set up" for every other state — incomplete, unknown
  // or never linked all lead to the same door.
  const payoutsRowState = stripeState === "ready" ? "Ready" : "Set up";

  /* PropLane pays is always offered: the option itself is the door to the code
     field, and the code — not a grant on the account — is what applies it. */
  const feePayerOptions = useMemo(
    () => [
      { value: "resident" as const, label: SERVICE_FEE_PAYER_OPTION_LABELS.resident },
      {
        value: "manager" as const,
        label: canSelectManagerAbsorb
          ? SERVICE_FEE_PAYER_OPTION_LABELS.manager
          : `${SERVICE_FEE_PAYER_OPTION_LABELS.manager} — needs paid plan`,
        disabled: !canSelectManagerAbsorb,
      },
      { value: "proplane" as const, label: SERVICE_FEE_PAYER_OPTION_LABELS.proplane },
    ],
    [canSelectManagerAbsorb],
  );

  const effectivePayerForProperty = useCallback(
    (propertyId: string): ServiceFeePayer =>
      resolveServiceFeePayerFor({
        tier,
        managerChoice: accountDefaultPayer,
        propertyChoice: propertyFeePayers[propertyId] ?? null,
        adminOverride: draft.adminServiceFeeOverride,
        waiverGranted: paymentWaiverGranted === true,
      }),
    [accountDefaultPayer, draft.adminServiceFeeOverride, paymentWaiverGranted, propertyFeePayers, tier],
  );

  /** The answer in force for the workspace being edited — what a pending pick has not replaced. */
  const savedWorkspacePayer: ServiceFeePayer =
    workspaceFeePayers[activeWorkspaceId] ?? accountDefaultPayer ?? "resident";

  async function applyWaiverCode() {
    const code = normalizeListingPaymentWaiverCode(waiverCodeDraft);
    /*
     * Shape only. Whether this is a REAL coverage code is the server's answer —
     * the codes are server-only now, because one of them was readable in a
     * client chunk and that is a credential. A wrong code comes back as the
     * route's 400 below rather than being judged here.
     */
    if (!isProcessingCoverageCodeShape(code)) {
      setWaiverCodeError(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID);
      return;
    }
    setWaiverCodeError(null);
    /*
     * One save, one scope: the workspace records PropLane pays together with
     * the code that applied it, and the route refuses the pair unless the code
     * checks out. With no workspace resolved — the modal rendered outside the
     * workspace provider, or its first load still in flight — the account
     * setting takes the same pair instead, which is what the workspace would
     * inherit anyway. Entering a valid code must never silently do nothing.
     */
    const saved = await persistSettings(
      activeWorkspaceId
        ? {
            workspaceId: activeWorkspaceId,
            workspaceServiceFeePayer: "proplane" as const,
            workspaceServiceFeeWaiverCode: code,
          }
        : { serviceFeePayer: "proplane", serviceFeeWaiverCode: code },
      "fee-payer",
      { onRefused: (error) => setWaiverCodeError(error) },
    );
    if (!saved) return;
    if (activeWorkspaceId) {
      setWorkspaceFeePayers((prev) => ({ ...prev, [activeWorkspaceId]: "proplane" }));
    }
    /* A code the server just accepted is a grant this screen may show: without
       it the account-scoped answer would resolve back to "resident" on screen
       while the server had in fact recorded PropLane pays. */
    setPaymentWaiverGranted(true);
    cancelProplanePending();
  }

  /**
   * Save the processing fee for the workspace being edited.
   *
   * One write, one scope. The old handler fanned the choice out across each
   * selected property and left every unselected one behind; here the workspace
   * holds the answer and a house only differs when it has been given its own.
   */
  const applyFeeToWorkspace = (raw: ServiceFeePayer) => {
    if (raw === "manager" && !canSelectManagerAbsorb) return;
    if (raw === "proplane") {
      /* Not a save. The select holds the pick and asks for the code; the
         answer already in force stays in force until the code is accepted. */
      setWaiverCodeDraft("");
      setWaiverCodeError(null);
      setProplanePending(true);
      return;
    }
    cancelProplanePending();
    if (!activeWorkspaceId) {
      /* No workspace resolved yet: save the account setting, which is what the
         workspace would inherit anyway. Refusing here would make the control
         look broken while the provider is still loading. */
      if (accountDefaultPayer === raw) return;
      void persistSettings({ serviceFeePayer: raw }, "fee-payer");
      return;
    }
    if ((workspaceFeePayers[activeWorkspaceId] ?? null) === raw) return;
    /* Optimistic, then reconciled from the save's own response — the control
       must never show a choice the server did not actually take. */
    setWorkspaceFeePayers((prev) => ({ ...prev, [activeWorkspaceId]: raw }));
    void persistSettings(
      { workspaceId: activeWorkspaceId, workspaceServiceFeePayer: raw },
      "fee-payer",
    );
  };

  /** The autopay toggles in force for the workspace being edited — default On when never saved. */
  const savedWorkspaceAutopay = workspaceAutopaySettings[activeWorkspaceId] ?? {
    autopayEnabled: true,
    autopayRetryEnabled: true,
  };

  const applyWorkspaceAutopayEnabled = (enabled: boolean) => {
    if (!activeWorkspaceId || savedWorkspaceAutopay.autopayEnabled === enabled) return;
    setWorkspaceAutopaySettings((prev) => ({
      ...prev,
      [activeWorkspaceId]: { ...savedWorkspaceAutopay, autopayEnabled: enabled },
    }));
    void persistSettings({ workspaceId: activeWorkspaceId, workspaceAutopayEnabled: enabled }, "autopay-enabled");
  };

  const applyWorkspaceAutopayRetryEnabled = (enabled: boolean) => {
    if (!activeWorkspaceId || savedWorkspaceAutopay.autopayRetryEnabled === enabled) return;
    setWorkspaceAutopaySettings((prev) => ({
      ...prev,
      [activeWorkspaceId]: { ...savedWorkspaceAutopay, autopayRetryEnabled: enabled },
    }));
    void persistSettings({ workspaceId: activeWorkspaceId, workspaceAutopayRetryEnabled: enabled }, "autopay-retry");
  };

  return (
    <div className="space-y-4">
      {loading ? <p className="text-sm text-muted">Loading…</p> : null}

      <button
        type="button"
        onClick={openPayouts}
        data-testid="payment-setup-stripe-card"
        data-attr="manager-payment-stripe-link"
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5 text-left transition hover:border-primary/30"
      >
        <div className="flex min-w-0 items-center gap-2">
          <CreditCard className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="text-sm font-semibold text-foreground">Payouts</span>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-muted">
          {payoutsRowState}
          <ChevronRight className="h-4 w-4" aria-hidden />
        </span>
      </button>

      {stripeIssue ? (
        <p className="text-xs leading-relaxed text-[var(--status-pending-fg)]">{stripeIssue}</p>
      ) : null}

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
          ) : null}

          <FieldSingleSelect
            label="Processing fee paid by"
            value={proplanePending ? "proplane" : savedWorkspacePayer}
            options={feePayerOptions}
            placeholder="Select…"
            onChange={(next) => applyFeeToWorkspace(next as ServiceFeePayer)}
            disabled={loading || (!settingsLoaded && !demo) || savingKey === "fee-payer"}
            dataAttr="manager-service-fee-payer-select"
            triggerClassName={proplanePending ? "border-primary ring-2 ring-primary/20" : undefined}
          />

          {proplanePending ? (
            <div
              className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 px-3 py-3"
              data-testid="manager-service-fee-waiver-entry"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="block text-xs font-semibold text-foreground" htmlFor="manager-service-fee-waiver-code">
                  Processing coverage code
                </label>
                <Badge tone="pending">{PROCESSING_FEE_PROPLANE_PENDING_LABEL}</Badge>
              </div>
              <input
                id="manager-service-fee-waiver-code"
                value={waiverCodeDraft}
                onChange={(event) => {
                  setWaiverCodeDraft(normalizeListingPaymentWaiverCode(event.target.value));
                  setWaiverCodeError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void applyWaiverCode();
                  }
                }}
                placeholder="Enter code"
                autoComplete="off"
                autoFocus
                disabled={savingKey === "fee-payer"}
                data-attr="manager-service-fee-waiver-code"
                aria-invalid={Boolean(waiverCodeError)}
                aria-describedby={waiverCodeError ? "manager-service-fee-waiver-error" : undefined}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm uppercase text-foreground placeholder:normal-case disabled:opacity-60 sm:max-w-xs"
              />
              <p className="text-xs text-muted">
                {processingFeeProplanePendingHelp(SERVICE_FEE_PAYER_SHORT_LABELS[savedWorkspacePayer])}
              </p>
              {waiverCodeError ? (
                <p id="manager-service-fee-waiver-error" className="text-xs text-destructive">
                  {waiverCodeError}
                </p>
              ) : null}
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  disabled={savingKey === "fee-payer" || (!settingsLoaded && !demo)}
                  data-attr="manager-service-fee-waiver-apply"
                  onClick={() => void applyWaiverCode()}
                  className="rounded-full bg-primary px-4 py-1.5 text-[13px] font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {savingKey === "fee-payer" ? "Checking…" : "Apply code"}
                </button>
                <button
                  type="button"
                  disabled={savingKey === "fee-payer"}
                  data-attr="manager-service-fee-waiver-cancel"
                  onClick={cancelProplanePending}
                  className="rounded-full border border-border px-4 py-1.5 text-[13px] font-semibold text-foreground disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {activeWorkspaceId ? (
        <section className="space-y-4">
          <FieldSingleSelect
            label="Residents can set up autopay"
            value={savedWorkspaceAutopay.autopayEnabled ? "on" : "off"}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            onChange={(next) => applyWorkspaceAutopayEnabled(next === "on")}
            disabled={loading || (!settingsLoaded && !demo) || savingKey === "autopay-enabled"}
            dataAttr="manager-autopay-enabled-select"
          />
          <FieldSingleSelect
            label="Autopay retries a declined payment"
            value={savedWorkspaceAutopay.autopayRetryEnabled ? "once" : "never"}
            options={[
              { value: "once", label: "Once, 3 days later" },
              { value: "never", label: "Never" },
            ]}
            onChange={(next) => applyWorkspaceAutopayRetryEnabled(next === "once")}
            disabled={loading || (!settingsLoaded && !demo) || savingKey === "autopay-retry"}
            dataAttr="manager-autopay-retry-select"
          />
        </section>
      ) : null}
    </div>
  );
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
  presetPropertyIds?: string[];
}) {
  return (
    <Modal
      open={open}
      title="Payment setup"
      onClose={onClose}
      dense
      assistantContext="Payment setup"
      panelClassName="max-w-lg"
    >
      <ManagerPaymentSetupPanel
        active={open}
        propertyOptions={propertyOptions}
        presetPropertyIds={presetPropertyIds}
      />
    </Modal>
  );
}
