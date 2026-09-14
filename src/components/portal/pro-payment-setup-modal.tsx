"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { openStripeConnectOnboarding } from "@/lib/stripe-connect-onboarding-client";
import {
  DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
  MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT,
  type ManagerManualPaymentSettingsView,
} from "@/lib/manager-manual-payment-settings";
import { normalizeManagerSkuTier, type ManagerSkuTier } from "@/lib/manager-access";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_HELP,
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  SERVICE_FEE_PAYER_OPTION_LABELS,
  listingPaymentWaiverCodeMatches,
  managerCanSelectManagerAbsorbServiceFee,
  managerCanSelectProplaneServiceFee,
  normalizeListingPaymentWaiverCode,
  resolveServiceFeePayerFor,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import {
  loadManagerPaymentWaiverGrantedClient,
  loadManagerSubscriptionTierClient,
} from "@/lib/manager-subscription-client";
import { stripeSetupStateFromStatus, type StripeSetupState } from "@/lib/stripe-setup-state";

const DEMO_INBOX = "payments+demo-token@prop-lane.space";

function draftFromSettings(settings: ManagerManualPaymentSettingsView | null): ManagerManualPaymentSettingsView {
  return settings ?? { ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, paymentInboxAddress: DEMO_INBOX };
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
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [stripeBusy, setStripeBusy] = useState(false);
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
  const workspaceCtx = useWorkspaces();
  /* Only workspaces the signed-in manager owns can have their payment setup
     changed here; a co-manager's access to someone else's house is unchanged. */
  const ownedWorkspaces = useMemo(
    () => (workspaceCtx?.workspaces ?? []).filter((w) => w.owned),
    [workspaceCtx?.workspaces],
  );
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const activeWorkspaceId =
    selectedWorkspaceId ||
    (workspaceCtx?.active?.owned ? workspaceCtx.active.id : "") ||
    ownedWorkspaces[0]?.id ||
    "";
  const activeWorkspace = ownedWorkspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  /*
    A manager PropLane has given a promo code to, but whose grant is not on the account
    yet, still needs a door. The option itself only appears once the grant is
    server-verified, so without this the code is unusable — and the server accepts one
    (`resolveSavedServiceFeeSelection`). The field asks for a code; it never prints one.
  */
  const [waiverPromptOpen, setWaiverPromptOpen] = useState(false);
  const [waiverCodeDraft, setWaiverCodeDraft] = useState("");
  const [waiverCodeError, setWaiverCodeError] = useState<string | null>(null);

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
        workspacePaymentSettings?: Record<string, { serviceFeePayer?: ServiceFeePayer | null }>;
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
    if (!open) {
      setSettingsLoaded(false);
      return;
    }
    void loadStripeStatus();
    void loadSettings();
    void loadTier();
  }, [open, loadStripeStatus, loadSettings, loadTier]);

  /* Reopening the modal drops any workspace the manager had switched to, so it
     always opens on the workspace they are actually working in. */
  useEffect(() => {
    if (!open) setSelectedWorkspaceId("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => void loadStripeStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, loadStripeStatus]);

  async function persistSettings(
    patch: Partial<ManagerManualPaymentSettingsView> & {
      propertyServiceFeePayers?: Array<{ propertyId: string; serviceFeePayer: ServiceFeePayer | null }>;
      /* A workspace-scoped save: the route re-checks the id against the
         signed-in owner, so this is a scope, never an authorization claim. */
      workspaceId?: string;
      workspaceServiceFeePayer?: ServiceFeePayer | null;
    },
    savingId: string,
  ) {
    if (!settingsLoaded && !demo) {
      showToast("Couldn't read your current payment setup, so nothing was changed. Reopen this window to try again.");
      return;
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
  const canSelectProplane = managerCanSelectProplaneServiceFee(tier, paymentWaiverGranted === true);
  const showFeePayerSection =
    tier === "pro" || tier === "business" || (tier === "free" && paymentWaiverGranted);
  const accountDefaultPayer = resolveServiceFeePayerFor({
    tier,
    managerChoice: draft.serviceFeePayer,
    adminOverride: draft.adminServiceFeeOverride,
    waiverGranted: paymentWaiverGranted === true,
  });

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
        { value: "resident" as const, label: SERVICE_FEE_PAYER_OPTION_LABELS.resident },
        {
          value: "manager" as const,
          label: canSelectManagerAbsorb
            ? SERVICE_FEE_PAYER_OPTION_LABELS.manager
            : `${SERVICE_FEE_PAYER_OPTION_LABELS.manager} — needs paid plan`,
          disabled: !canSelectManagerAbsorb,
        },
        ...(canSelectProplane
          ? [{ value: "proplane" as const, label: SERVICE_FEE_PAYER_OPTION_LABELS.proplane }]
          : []),
      ],
    [canSelectManagerAbsorb, canSelectProplane],
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

  async function applyWaiverCode() {
    const code = normalizeListingPaymentWaiverCode(waiverCodeDraft);
    if (!listingPaymentWaiverCodeMatches(code)) {
      setWaiverCodeError(LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID);
      return;
    }
    setWaiverCodeError(null);
    /*
     * The code establishes the grant on the ACCOUNT; the workspace then records
     * that PropLane covers it, which is the scope the fee is answered at.
     *
     * With no workspace resolved — the modal rendered outside the workspace
     * provider, or its first load still in flight — this saves the account
     * setting alone rather than refusing. Entering a valid code must never
     * silently do nothing.
     */
    await persistSettings(
      {
        serviceFeePayer: "proplane",
        serviceFeeWaiverCode: code,
        ...(activeWorkspaceId
          ? { workspaceId: activeWorkspaceId, workspaceServiceFeePayer: "proplane" as const }
          : {}),
      },
      "fee-payer",
    );
    if (activeWorkspaceId) {
      setWorkspaceFeePayers((prev) => ({ ...prev, [activeWorkspaceId]: "proplane" }));
    }
    setPaymentWaiverGranted(true);
    setWaiverPromptOpen(false);
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
    if (raw === "proplane" && !canSelectProplane) return;
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
            ) : ownedWorkspaces.length > 1 ? (
              <FieldSingleSelect
                label="Workspace"
                value={activeWorkspaceId}
                options={ownedWorkspaces.map((w) => ({ value: w.id, label: w.name }))}
                placeholder="Select a workspace…"
                onChange={(next) => setSelectedWorkspaceId(next)}
                disabled={loading || Boolean(savingKey)}
                dataAttr="manager-payment-setup-workspace"
              />
            ) : (
              /* One workspace is what every live account has, and a dropdown
                 with a single entry is a decision you cannot make. Name what is
                 being edited instead; the picker returns with a second one. */
              <p className="text-sm text-foreground" data-attr="manager-payment-setup-workspace-name">
                <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Workspace · </span>
                {activeWorkspace?.name ?? "My workspace"}
              </p>
            )}

            <FieldSingleSelect
              label="Processing fee paid by"
              value={workspaceFeePayers[activeWorkspaceId] ?? accountDefaultPayer ?? ""}
              options={feePayerOptions}
              placeholder="Select…"
              onChange={(next) => applyFeeToWorkspace(next as ServiceFeePayer)}
              disabled={loading || (!settingsLoaded && !demo) || savingKey === "fee-payer"}
              dataAttr="manager-service-fee-payer-select"
            />

            <p className="text-xs leading-relaxed text-muted">
              Applies to every home in{" "}
              <span className="font-semibold text-foreground">{activeWorkspace?.name ?? "this workspace"}</span>. A
              single home can still be given its own on that listing. Rent deposits to the owner&apos;s bank either
              way.
            </p>

            {!paymentWaiverGranted ? (
              waiverPromptOpen ? (
                <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 px-3 py-3">
                  <label className="block text-xs font-semibold text-foreground" htmlFor="manager-service-fee-waiver-code">
                    Promo code
                  </label>
                  <input
                    id="manager-service-fee-waiver-code"
                    value={waiverCodeDraft}
                    onChange={(event) => {
                      setWaiverCodeDraft(normalizeListingPaymentWaiverCode(event.target.value));
                      setWaiverCodeError(null);
                    }}
                    placeholder="Promo code"
                    autoComplete="off"
                    data-attr="manager-service-fee-waiver-code"
                    aria-invalid={Boolean(waiverCodeError)}
                    aria-describedby={waiverCodeError ? "manager-service-fee-waiver-error" : undefined}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm uppercase text-foreground sm:max-w-xs"
                  />
                  <p className="text-xs text-muted">{LISTING_PROCESSING_FEE_WAIVER_CODE_HELP}</p>
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
                      Apply code
                    </button>
                    <button
                      type="button"
                      data-attr="manager-service-fee-waiver-cancel"
                      onClick={() => {
                        setWaiverPromptOpen(false);
                        setWaiverCodeError(null);
                      }}
                      className="rounded-full border border-border px-4 py-1.5 text-[13px] font-semibold text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  data-attr="manager-service-fee-waiver-open"
                  onClick={() => {
                    setWaiverCodeDraft("");
                    setWaiverCodeError(null);
                    setWaiverPromptOpen(true);
                  }}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  Have a PropLane promo code?
                </button>
              )
            ) : null}
          </section>
        ) : (
          <p className="text-xs leading-relaxed text-muted">
            On Free, residents pay processing fees. Pro and Business let managers choose to pay instead. PropLane covers
            it with a promo code — enter yours on a listing&apos;s Pricing step.
          </p>
        )}
      </div>
    </Modal>
  );
}

function busyLabel(busy: boolean, label: string) {
  return busy ? "Opening…" : label;
}
