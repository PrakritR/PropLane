"use client";
import { useEffect, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Button } from "@/components/ui/button";
import { PortalSettingsSection, PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
export function ManagerPaymentSourceSetting() {
  const [value, setValue] = useState("balance");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void fetch("/api/portal/payment-preferences").then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error); if (active) { setValue(data.defaultPaymentSource); setReady(true); } }).catch(() => { if (active) setError("Could not load payment preferences."); }); return () => { active = false; }; }, []);
  async function save() { try { const response = await fetch("/api/portal/payment-preferences", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ defaultPaymentSource: value }) }); if (!response.ok) throw new Error(); setError(null); } catch { setError("Could not save payment preferences."); } }
  return <PortalSettingsSection title="Payments"><PortalSettingsGroup><div className="space-y-3 p-4"><FieldSingleSelect label="Default payment method" value={value} onChange={setValue} disabled={!ready} options={[{ value: "balance", label: "PropLane balance" }, { value: "bank", label: "Bank" }]} /><Button onClick={save} disabled={!ready}>Save</Button>{error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}</div></PortalSettingsGroup></PortalSettingsSection>;
}
