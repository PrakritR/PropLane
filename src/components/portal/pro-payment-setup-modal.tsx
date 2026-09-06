"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
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
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { loadManagerPaymentWaiverGrantedClient } from "@/lib/manager-subscription-client";
import { stripeSetupStateFromStatus, type StripeSetupState } from "@/lib/stripe-setup-state";

const DEMO_INBOX = "payments+demo-token@prop-lane.space";

const SERVICE_FEE_PAYER_OPTIONS: {
  id: ServiceFeePayer;
  title: string;
  detail: string;
}[] = [
  { id: "resident", title: "Resident pays", detail: "Added at checkout" },
  { id: "manager", title: "I'll cover it", detail: "Deducted from your payout" },
  { id: "proplane", title: "PropLane covers it", detail: "No fee to you or residents" },
];

function draftFromSettings(settings: ManagerManualPaymentSettingsView | null): ManagerManualPaymentSettingsView {
  return settings ?? { ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS, paymentInboxAddress: DEMO_INBOX };
}

function HubRow({
  label,
  connected,
  onLink,
  dataAttr,
  busy,
  linkLabel = "Link",
  pending = false,
  pendingLabel = "Finish setup",
  allowed,
  onAllowedChange,
  allowDataAttr,
}: {
  label: string;
  connected: boolean;
  onLink: () => void;
  dataAttr: string;
  busy?: boolean;
  linkLabel?: string;
  /** Account exists but Stripe reports it cannot yet receive money (onboarding incomplete). */
  pending?: boolean;
  pendingLabel?: string;
  /** Whether residents may use this method. */
  allowed: boolean;
  onAllowedChange: (allowed: boolean) => void;
  allowDataAttr: string;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
      <label className="flex min-w-0 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded border-border"
          checked={allowed}
          onChange={(e) => onAllowedChange(e.target.checked)}
          data-attr={allowDataAttr}
        />
        <span className="text-sm font-semibold text-foreground">{label}</span>
      </label>
      {connected ? (
        <button
          type="button"
          onClick={onLink}
          data-attr={dataAttr}
          className="shrink-0 text-sm font-medium text-[var(--status-confirmed-fg)] hover:underline"
        >
          Connected · Manage
        </button>
      ) : pending ? (
        <button
          type="button"
          onClick={onLink}
          disabled={busy}
          data-attr={dataAttr}
          className="shrink-0 text-sm font-medium text-[var(--status-pending-fg)] hover:underline disabled:opacity-50"
        >
          {busy ? "Opening…" : `${pendingLabel} →`}
        </button>
      ) : (
        <button
          type="button"
          onClick={onLink}
          disabled={busy}
          data-attr={dataAttr}
          className="shrink-0 text-sm font-medium text-primary hover:underline disabled:opacity-50"
        >
          {busy ? "Opening…" : linkLabel}
        </button>
      )}
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
  /** When set, skip the property picker and scope saves to these ids (e.g. resident detail). */
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
  const [savingFeePayer, setSavingFeePayer] = useState(false);
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<Set<string>>(() => new Set());
  const [propertySelectionComplete, setPropertySelectionComplete] = useState(false);

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
        // A refused status answers `{ error }` alone, so the optional fields are
        // absent — reading them first would leave bank editing enabled and throw
        // away the only sentence that says why it cannot work.
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
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/portal/manager-manual-payment-settings", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load payment setup.");
        return;
      }
      setDraft(draftFromSettings(data.settings ?? null));
    } catch {
      showToast("Could not load payment setup.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

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
      /* leave null — the fee-payer chooser simply stays hidden */
    }
  }, [demo]);

  useEffect(() => {
    if (!open) {
      setPropertySelectionComplete(false);
      setSelectedPropertyIds(new Set());
      return;
    }
    void loadStripeStatus();
    void loadSettings();
    void loadTier();
  }, [open, loadStripeStatus, loadSettings, loadTier]);

  useEffect(() => {
    if (!open) return;
    if (presetPropertyIds?.length) {
      setSelectedPropertyIds(new Set(presetPropertyIds));
      setPropertySelectionComplete(true);
      return;
    }
    if (!propertySelectionComplete && selectedPropertyIds.size === 0 && propertyOptions.length > 0) {
      setSelectedPropertyIds(new Set(propertyOptions.map((property) => property.id)));
    }
  }, [open, presetPropertyIds, propertyOptions, propertySelectionComplete, selectedPropertyIds.size]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => void loadStripeStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, loadStripeStatus]);

  async function persistSettings(patch: Partial<ManagerManualPaymentSettingsView>) {
    if (demo) {
      setDraft((prev) => draftFromSettings({ ...prev, ...patch }));
      showToast("Saved (demo).");
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
          receiptAutoMarkEnabled: patch.receiptAutoMarkEnabled ?? draft.receiptAutoMarkEnabled !== false,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        settings?: ManagerManualPaymentSettingsView;
        error?: string;
        chargesUpdated?: number;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not save payment setup.");
        return;
      }
      if (data.settings) {
        setDraft(draftFromSettings(data.settings));
        window.dispatchEvent(new CustomEvent(MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT));
      }
      const chargeNote =
        typeof data.chargesUpdated === "number" && data.chargesUpdated > 0
          ? ` Updated ${data.chargesUpdated} open charge${data.chargesUpdated === 1 ? "" : "s"}.`
          : "";
      showToast(`Payment setup saved.${chargeNote}`);
    } catch {
      showToast("Could not save payment setup.");
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

  async function changeFeePayer(choice: ServiceFeePayer) {
    if ((draft.serviceFeePayer ?? "resident") === choice) return;
    setSavingFeePayer(true);
    try {
      await persistSettings({ serviceFeePayer: choice });
    } finally {
      setSavingFeePayer(false);
    }
  }

  const allPropertiesSelected = propertyOptions.length > 0 && selectedPropertyIds.size === propertyOptions.length;
  const toggleAllProperties = (checked: boolean) => {
    setSelectedPropertyIds(checked ? new Set(propertyOptions.map((property) => property.id)) : new Set());
  };
  const toggleProperty = (id: string, checked: boolean) => {
    setSelectedPropertyIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <>
      <Modal
        open={open && !propertySelectionComplete && !presetPropertyIds?.length}
        title="Choose properties for payment setup"
        description="Stripe payout settings apply to residents and applicants for these properties."
        onClose={onClose}
        dense
        assistantContext="Payment setup"
        panelClassName="max-w-md"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              disabled={selectedPropertyIds.size === 0 || propertyOptions.length === 0}
              data-attr="manager-payment-properties-continue"
              onClick={() => setPropertySelectionComplete(true)}
            >
              Continue
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-accent/20 px-3 py-2.5">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border text-primary"
              checked={allPropertiesSelected}
              disabled={propertyOptions.length === 0}
              data-attr="manager-payment-all-properties"
              onChange={(event) => toggleAllProperties(event.target.checked)}
            />
            <span className="text-sm font-semibold text-foreground">All properties</span>
          </label>
          <div className="max-h-[min(40vh,16rem)] space-y-1 overflow-y-auto rounded-xl border border-border p-2">
            {propertyOptions.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted">No properties in portfolio yet.</p>
            ) : (
              propertyOptions.map((property) => (
                <label
                  key={property.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/30"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 rounded border-border text-primary"
                    checked={selectedPropertyIds.has(property.id)}
                    data-attr={`manager-payment-property-${property.id}`}
                    onChange={(event) => toggleProperty(property.id, event.target.checked)}
                  />
                  <span className="min-w-0 text-sm text-foreground">{property.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      </Modal>

      <Modal open={open && propertySelectionComplete} title="Payment setup" onClose={onClose} assistantContext="Payment setup">
        <div className="space-y-3">
          {loading ? <p className="text-sm text-muted">Loading…</p> : null}
          <HubRow
            label="Stripe (ACH & card)"
            connected={stripeState === "ready"}
            pending={stripeState === "incomplete"}
            pendingLabel="Finish setup"
            onLink={() => void linkStripe()}
            dataAttr="manager-payment-stripe-link"
            busy={stripeBusy}
            allowed={draft.axisPaymentsEnabled !== false}
            allowDataAttr="manager-payment-stripe-allowed"
            onAllowedChange={(allowed) => void persistSettings({ axisPaymentsEnabled: allowed })}
          />
          {isCoManagerForPayout ? (
            <p className="text-xs text-muted">
              {canEditBankAccount
                ? "You are updating the property owner&apos;s payout bank account."
                : "Payout bank details belong to the property owner. Grant Bank account write access in Co-managers to change them."}
            </p>
          ) : null}
          {stripeState === "incomplete" ? (
            <p className="text-xs text-[var(--status-pending-fg)]">
              Your Stripe account isn&apos;t ready to receive money yet. Finish onboarding (identity + bank details) so
              resident payments can be deposited.
            </p>
          ) : null}
          {stripeState === "unknown" && stripeIssue ? (
            <p className="text-xs text-[var(--status-pending-fg)]">{stripeIssue}</p>
          ) : null}
          {skuTier === "pro" || skuTier === "business" || (skuTier === "free" && paymentWaiverGranted) ? (
            <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3.5">
              <p className="text-sm font-semibold text-foreground">Online payment service fee</p>
              <p className="text-xs text-muted">
                Choose who pays Stripe&apos;s processing fee on resident online payments (card, bank, Link). Rent still
                deposits into the property owner&apos;s bank account either way.
              </p>
              <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3">
                {SERVICE_FEE_PAYER_OPTIONS.filter((option) => {
                  const tier = skuTier ?? "free";
                  if (option.id === "proplane") return managerCanSelectProplaneServiceFee(tier, paymentWaiverGranted);
                  if (option.id === "manager") return managerCanSelectManagerAbsorbServiceFee(tier);
                  return true;
                }).map((option) => {
                  const selected =
                    (draft.serviceFeePayer ?? (skuTier === "free" ? "resident" : "proplane")) === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={savingFeePayer}
                      onClick={() => void changeFeePayer(option.id)}
                      data-attr={`manager-service-fee-payer-${option.id}`}
                      className={`flex flex-col rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60 ${
                        selected
                          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                          : "border-border bg-background hover:border-primary/30"
                      }`}
                    >
                      <span className="text-sm font-semibold text-foreground">
                        {option.id === "proplane" && skuTier === "free" ? "PropLane covers it (FREE100)" : option.title}
                      </span>
                      <span className="mt-0.5 text-xs text-muted">{option.detail}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : skuTier === "free" ? (
            <p className="text-xs text-muted">
              On the Free plan, residents cover the payment processing fee unless your account has the FREE100 waiver
              code or you upgrade to Pro or Business.
            </p>
          ) : null}
          <p className="text-xs text-muted">
            Residents pay rent and fees through PropLane secure checkout — bank transfer (ACH) or card. Zelle and Venmo
            are no longer supported.
          </p>
        </div>
      </Modal>
    </>
  );
}
