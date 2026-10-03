"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT, type ManagerManualPaymentSettingsView } from "@/lib/manager-manual-payment-settings";
import { resolveServiceFeePayerFor, type ServiceFeePayer } from "@/lib/payment-policy";
import { loadManagerSubscriptionTierClient, loadManagerPaymentWaiverGrantedClient } from "@/lib/manager-subscription-client";
import { normalizeManagerSkuTier, type ManagerSkuTier } from "@/lib/manager-access";

const endpoint = "/api/portal/manager-manual-payment-settings";

/** Account default only. Property and workspace overrides remain owned by their editors. */
export function AccountProcessingFeeSettings() {
  const { showToast } = useAppUi();
  const [tier, setTier] = useState<ManagerSkuTier | null>(null);
  const [waiverGranted, setWaiverGranted] = useState(false);
  const [settings, setSettings] = useState<ManagerManualPaymentSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([loadManagerSubscriptionTierClient(), loadManagerPaymentWaiverGrantedClient()]).then(([value, grant]) => { if (active) { setTier(normalizeManagerSkuTier(value)); setWaiverGranted(grant === true); } }).catch(() => { if (active) setError("Could not load your plan."); });
    void fetch(endpoint, { credentials: "include" }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load processing fees.");
      if (active) setSettings(body.settings);
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  async function save(payer: ServiceFeePayer, coverageCode = "") {
    if (busy || !settings) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceFeePayer: payer, serviceFeeWaiverCode: coverageCode }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not save processing fees.");
      setSettings(body.settings); setOpen(false); setCode("");
      window.dispatchEvent(new CustomEvent(MANAGER_MANUAL_PAYMENT_SETTINGS_EVENT));
      showToast("Processing fee saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save processing fees."); }
    finally { setBusy(false); }
  }
  const payer = resolveServiceFeePayerFor({ tier: tier ?? "free", managerChoice: settings?.serviceFeePayer, adminOverride: settings?.adminServiceFeeOverride, waiverGranted: waiverGranted || Boolean(settings?.serviceFeeWaiverCode) });
  return <PortalSettingsSection title="Defaults"><PortalSettingsGroup>
    <PortalSettingsRow label="Processing fee paid by">
      <FieldSingleSelect label="Processing fee paid by" hideLabel variant="cell" value={payer}
        disabled={!settings || !tier || busy || Boolean(settings.adminServiceFeeOverride)}
        options={[{ value: "resident", label: "Resident pays" }, { value: "manager", label: "You pay", disabled: tier === "free" }, { value: "proplane", label: "PropLane pays" }]}
        onChange={(value) => { if (value === "proplane") { setCode(""); setError(null); setOpen(true); } else void save(value as ServiceFeePayer); }}
        dataAttr="account-processing-fee-payer" />
    </PortalSettingsRow>
    {payer === "proplane" && settings?.serviceFeeWaiverCode ? <PortalSettingsRow label="Code">
      <span className="font-mono text-sm">••••{settings.serviceFeeWaiverCode.slice(-4)}</span>
      <RecordActionContext.Provider value={{ scope: "processing-coverage", clear: () => {}, actions: <Button variant="danger" disabled={busy} onClick={() => save("resident")}>Remove code</Button> }}>
        <RecordActionMenu label="Coverage code" activate={() => {}} />
      </RecordActionContext.Provider>
    </PortalSettingsRow> : null}
    {error && !open ? <p role="alert" className="px-4 py-2 text-sm text-danger">{error}</p> : null}
  </PortalSettingsGroup>
    <Modal open={open} title="Processing coverage code" onClose={() => { if (!busy) { setOpen(false); setError(null); } }}>
      <label className="block text-xs uppercase text-muted" htmlFor="account-coverage-code">Processing coverage code</label>
      <input id="account-coverage-code" autoComplete="off" autoCapitalize="characters" value={code} disabled={busy}
        onChange={(event) => setCode(event.target.value)} className="mt-2 w-full rounded-xl border border-border p-3 font-mono" />
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
      <ModalFooter><Button disabled={busy || !code.trim()} onClick={() => save("proplane", code.trim())}>Apply code</Button></ModalFooter>
    </Modal>
  </PortalSettingsSection>;
}
