"use client";

import { useEffect, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { PortalStripeConnectPanel } from "@/components/portal/portal-stripe-connect-panel";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { buildVendorAcceptedPaymentMethods, VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS } from "@/lib/vendor-payment-methods";

type VendorPaymentMethodsDraft = {
  achPaymentsEnabled: boolean;
};

function draftFromProfile(profile: ManagerVendorRow | null): VendorPaymentMethodsDraft {
  return { achPaymentsEnabled: Boolean(profile?.achPaymentsEnabled) };
}

export function VendorPaymentMethodsModal({
  open,
  onClose,
  profile,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  profile: ManagerVendorRow | null;
  onSaved: (profile: ManagerVendorRow) => void;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [draft, setDraft] = useState<VendorPaymentMethodsDraft>(() => draftFromProfile(profile));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFromProfile(profile));
  }, [open, profile]);

  const toggleAch = (enabled: boolean) => setDraft({ achPaymentsEnabled: enabled });

  async function save() {
    if (!draft.achPaymentsEnabled) {
      showToast("Turn on bank (ACH) payouts to get paid through PropLane.");
      return;
    }

    const acceptedPaymentMethods = buildVendorAcceptedPaymentMethods({ achPaymentsEnabled: draft.achPaymentsEnabled });

    const payload = {
      achPaymentsEnabled: draft.achPaymentsEnabled,
      acceptedPaymentMethods,
    };

    if (demo) {
      if (!profile) {
        showToast("No vendor profile in demo mode.");
        return;
      }
      onSaved({ ...profile, ...payload });
      showToast("Payment methods saved.");
      onClose();
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/vendor/profile", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { profile?: ManagerVendorRow; error?: string };
      if (!res.ok || !data.profile) {
        showToast(data.error ?? "Could not save payment methods.");
        return;
      }
      onSaved(data.profile);
      showToast("Payment methods saved.");
      onClose();
    } catch {
      showToast("Could not save payment methods.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Payment methods"
      onClose={onClose}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            onClick={() => save()}
            disabled={saving}
            data-attr="vendor-payment-methods-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="space-y-2 rounded-xl border border-border bg-card p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border"
              checked={draft.achPaymentsEnabled}
              onChange={(e) => toggleAch(e.target.checked)}
              data-attr="vendor-payment-ach-toggle"
            />
            <span className="text-sm font-medium text-foreground">
              {VENDOR_ACCEPTED_PAYMENT_METHOD_LABELS.ach} with Stripe Connect
            </span>
          </label>
          {draft.achPaymentsEnabled ? (
            <div className="pl-7">
              <PortalStripeConnectPanel
                basePath="/vendor"
                apiBase="/api/vendor/stripe-connect"
                returnPath="/vendor/financials/payouts"
                dataAttrPrefix="vendor-stripe-connect"
                variant="embedded"
                analyticsScope="vendor"
              />
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
