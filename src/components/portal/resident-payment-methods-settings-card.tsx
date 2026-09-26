"use client";

/**
 * C145 — payment methods and autopay move into Settings, alongside sign
 * out. Payments (`resident-payments-panel.tsx`) keeps owning charge history
 * and the per-charge Pay flow; saved cards/bank accounts and the autopay
 * schedule are account-level settings, not a payments-list concern, so they
 * live here instead. Self-contained: its own saved-methods state and its own
 * "add a method" Stripe setup flow, independent of the Payments panel.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { StripeEmbeddedCheckout } from "@/components/stripe-embedded-checkout";
import { ResidentAutopayCard } from "@/components/portal/resident-autopay-card";
import { PortalSettingsRow, PortalSettingsSection, PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { isDemoModeActive } from "@/lib/demo/demo-session";

type SavedPaymentMethod = {
  id: string;
  type: "card" | "us_bank_account";
  label: string;
  isDefault: boolean;
};

export function ResidentPaymentMethodsSettingsCard({ basePath = "/resident" }: { basePath?: string }) {
  const { showToast } = useAppUi();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [paymentMethodModalOpen, setPaymentMethodModalOpen] = useState(false);
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([]);
  const [savedMethodsLoading, setSavedMethodsLoading] = useState(false);
  const [setupCheckout, setSetupCheckout] = useState<{ kind: "card" | "ach"; clientSecret: string } | null>(null);
  const [setupLoading, setSetupLoading] = useState<"card" | "ach" | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

  const reloadSavedMethods = useCallback(async () => {
    if (isDemoModeActive()) {
      setSavedMethods([]);
      return;
    }
    setSavedMethodsLoading(true);
    try {
      const res = await fetch("/api/stripe/resident-payment-methods", { credentials: "include", cache: "no-store" });
      const data = (await res.json()) as { methods?: SavedPaymentMethod[] };
      setSavedMethods(Array.isArray(data.methods) ? data.methods : []);
    } catch {
      setSavedMethods([]);
    } finally {
      setSavedMethodsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!paymentMethodModalOpen) {
      setSetupCheckout(null);
      return;
    }
    void reloadSavedMethods();
  }, [paymentMethodModalOpen, reloadSavedMethods]);

  useEffect(() => {
    if (searchParams.get("payment_method") !== "added") return;
    void reloadSavedMethods();
    setPaymentMethodModalOpen(true);
    router.replace(`${basePath}/profile?tab=account`, { scroll: false });
  }, [basePath, reloadSavedMethods, router, searchParams]);

  const startAddPaymentMethod = useCallback(
    async (kind: "card" | "ach") => {
      if (isDemoModeActive()) {
        showToast("Payment methods are unavailable in demo mode.");
        return;
      }
      setSetupLoading(kind);
      try {
        const returnUrl = `${window.location.origin}${basePath}/profile?tab=account&payment_method=added`;
        const res = await fetch("/api/stripe/resident-payment-methods", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ kind, returnUrl }),
        });
        const data = (await res.json()) as { clientSecret?: string; error?: string };
        if (!res.ok || !data.clientSecret) {
          showToast(data.error ?? "Could not add payment method.");
          return;
        }
        setSetupCheckout({ kind, clientSecret: data.clientSecret });
      } finally {
        setSetupLoading(null);
      }
    },
    [basePath, showToast],
  );

  const setDefaultPaymentMethod = useCallback(
    async (paymentMethodId: string) => {
      if (isDemoModeActive()) {
        showToast("Payment methods are unavailable in demo mode.");
        return;
      }
      setSettingDefaultId(paymentMethodId);
      try {
        const res = await fetch("/api/stripe/resident-payment-methods", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ paymentMethodId }),
        });
        const data = (await res.json()) as { methods?: SavedPaymentMethod[]; error?: string };
        if (!res.ok) {
          showToast(data.error ?? "Could not set default payment method.");
          return;
        }
        setSavedMethods(Array.isArray(data.methods) ? data.methods : []);
        showToast("Default payment method updated.");
      } finally {
        setSettingDefaultId(null);
      }
    },
    [showToast],
  );

  return (
    <>
      <PortalSettingsSection title="Payments">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Payment methods">
            <Button
              type="button"
              variant="outline"
              className="px-4 text-[13px]"
              data-attr="resident-settings-manage-payment-methods"
              onClick={() => setPaymentMethodModalOpen(true)}
            >
              Manage
            </Button>
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>

      <ResidentAutopayCard
        onManagePaymentMethods={() => setPaymentMethodModalOpen(true)}
        // Reuses the C248 `?pay=<chargeId>` shortcut — resident-payments-panel.tsx
        // opens the pay confirmation for this exact charge, rather than this
        // card duplicating checkout state of its own.
        onPayChargeNow={(chargeId) => router.push(`${basePath}/payments?pay=${encodeURIComponent(chargeId)}`)}
      />

      <Modal
        open={paymentMethodModalOpen}
        onClose={() => {
          setSetupCheckout(null);
          setPaymentMethodModalOpen(false);
        }}
        title="Payment methods"
        panelClassName="max-w-lg"
      >
        {setupCheckout ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Add {setupCheckout.kind === "card" ? "a credit card" : "a bank account"} to pay in PropLane.
            </p>
            <StripeEmbeddedCheckout clientSecret={setupCheckout.clientSecret} />
            <div className="flex justify-start">
              <Button type="button" variant="outline" className="rounded-full" onClick={() => setSetupCheckout(null)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted">
              Save a bank account or card for faster checkout. Choose your default below — you pick how to pay each
              time you pay a charge.
            </p>

            <div>
              {savedMethodsLoading ? (
                <p className="text-sm text-muted">Loading saved methods…</p>
              ) : savedMethods.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-accent/20 px-4 py-3 text-sm text-muted">
                  No saved payment methods yet. Add a bank account or card below.
                </p>
              ) : (
                <ul className="space-y-2" role="radiogroup" aria-label="Default payment method">
                  {savedMethods.map((method) => (
                    <li key={method.id}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition ${
                          method.isDefault
                            ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                            : "border-border bg-card hover:border-primary/30"
                        }`}
                      >
                        <input
                          type="radio"
                          name="resident-default-payment-method"
                          className="h-4 w-4 shrink-0 border-border text-primary"
                          checked={method.isDefault}
                          disabled={settingDefaultId !== null}
                          data-attr="resident-payments-set-default"
                          onChange={() => {
                            if (!method.isDefault) void setDefaultPaymentMethod(method.id);
                          }}
                        />
                        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{method.label}</span>
                        {method.isDefault ? (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            Default
                          </span>
                        ) : settingDefaultId === method.id ? (
                          <span className="shrink-0 text-xs text-muted">Saving…</span>
                        ) : null}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Add</p>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl border border-dashed border-border bg-card px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
                disabled={setupLoading !== null}
                data-attr="resident-payments-add-bank"
                onClick={() => {
                  return startAddPaymentMethod("ach");
                }}
              >
                <span>Bank (ACH)</span>
                <span className="text-xs font-medium text-muted">{setupLoading === "ach" ? "Loading…" : "Add"}</span>
              </button>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl border border-dashed border-border bg-card px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
                disabled={setupLoading !== null}
                data-attr="resident-payments-add-card"
                onClick={() => {
                  return startAddPaymentMethod("card");
                }}
              >
                <span>Credit card</span>
                <span className="text-xs font-medium text-muted">{setupLoading === "card" ? "Loading…" : "Add"}</span>
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
