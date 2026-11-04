"use client";
import { coordinationQuote } from "@/lib/vendor-coordination-view";
import { useCallback, useEffect, useState } from "react";
import { CountStepper } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Button } from "@/components/ui/button";
import { PortalSettingsSection, PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { quoteTotalCents, type CoordinationProposal, type CoordinationAction } from "@/lib/vendor-coordination";

/** All portals use the same server record. Local snapshots contain no coordination state. */
export function ServiceCoordinationCard({ workOrderId, role, vendorDirectoryId }: { workOrderId: string; role: "manager" | "resident" | "vendor"; vendorDirectoryId?: string }) {
  const [proposals, setProposals] = useState<CoordinationProposal[]>([]);
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [vendorId, setVendorId] = useState(vendorDirectoryId ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [start, setStart] = useState(""); const [end, setEnd] = useState("");
  const [extraWindows, setExtraWindows] = useState<{startIso: string; endIso: string}[]>([]);
  const [duration, setDuration] = useState(60);
  const [scope, setScope] = useState(""); const [exclusions, setExclusions] = useState("");
  const [labor, setLabor] = useState(""); const [materials, setMaterials] = useState(""); const [fee, setFee] = useState("");
  const load = useCallback(async () => { const response = await fetch(`/api/portal/vendor-coordination?workOrderId=${encodeURIComponent(workOrderId)}`, { cache: "no-store" }); const json = await response.json(); if (!response.ok) throw new Error(json.error); setProposals(json.proposals); setVendors(json.vendors ?? []); }, [workOrderId]);
  useEffect(() => { let current = true; load().catch((e) => { if (current) setError(e.message); }).finally(() => { if (current) setLoading(false); }); return () => { current = false; }; }, [load]);
  async function save(action: CoordinationAction | Record<string, unknown>) { setError(""); try { const response = await fetch("/api/portal/vendor-coordination", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }); const json = await response.json(); if (!response.ok) throw new Error(json.error); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Unable to save."); } }
  const field = "min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm";
  if (loading) return <div role="status" className="px-4 py-3">Loading visit proposals</div>;
  if (!proposals.length && role !== "manager" && !error) return null;
  return <div className="px-3 py-4 sm:px-4" data-attr="service-coordination"><PortalSettingsSection title="Visit coordination">
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {role === "manager" && (vendorId || vendors.length > 0) && <div className="flex flex-wrap gap-2">
      <FieldSingleSelect label="Vendor" value={vendorId} onChange={setVendorId} options={vendors.map((vendor) => ({ value: vendor.id, label: vendor.name }))} placeholder="Choose vendor" dataAttr="service-coordination-vendor" />
      {(["consultation", "repair"] as const).map((visit) => <Button key={visit} variant="outline" disabled={!vendorId} onClick={() => save({ kind: "enroll", work_order_id: workOrderId, vendor_directory_id: vendorId, visit_type: visit, manager_user_id: "", actor_user_id: "" })}>Coordinate {visit}</Button>)}
    </div>}
    {proposals.map((p) => { const base = { proposal_id: p.id, expected_version: p.version }; const terminal = ["approved", "cancelled", "declined"].includes(p.status); return <PortalSettingsGroup key={p.id}>
      <PortalSettingsRow label="Vendor">{vendors.find((v) => v.id === p.vendor_directory_id)?.name || "Vendor"}</PortalSettingsRow><PortalSettingsRow label="Visit">{p.visit_type}</PortalSettingsRow>
      <PortalSettingsRow label="Status">{p.status}</PortalSettingsRow><PortalSettingsRow label="Vendor agreement">{p.vendor_confirmed_revision === p.quote_revision ? "Confirmed" : "Pending"}</PortalSettingsRow><PortalSettingsRow label="Resident agreement">{p.resident_confirmed_revision === p.quote_revision ? "Confirmed" : "Pending"}</PortalSettingsRow>
      <PortalSettingsRow label="Time (Pacific)">{p.selected_start_at ? formatPacificDateTime(p.selected_start_at) : "Not selected"}</PortalSettingsRow><PortalSettingsRow label="Duration">{p.duration_minutes ? `${p.duration_minutes} minutes` : "Pending vendor confirmation"}</PortalSettingsRow>
      {role !== "resident" && coordinationQuote(p) && <><PortalSettingsRow label="Scope">{coordinationQuote(p)!.scope}</PortalSettingsRow><PortalSettingsRow label="Exclusions">{coordinationQuote(p)!.exclusions || "None"}</PortalSettingsRow><PortalSettingsRow label="Total">${(quoteTotalCents(p.visit_type, coordinationQuote(p)!) / 100).toFixed(2)}</PortalSettingsRow></>}
      {!terminal && <div className="space-y-3 p-3">
        {role === "vendor" && <><label className="block">Scope<input className={field} value={scope} onChange={(e) => setScope(e.target.value)} /></label><label className="block">Exclusions<input className={field} value={exclusions} onChange={(e) => setExclusions(e.target.value)} /></label>
          <div className="grid gap-3 sm:grid-cols-3">{([["Labor ($)", labor, setLabor], ["Materials ($)", materials, setMaterials], ["Consultation fee ($)", fee, setFee]] as const).map(([label, value, set]) => <label key={label}>{label}<input type="number" min={0} step="0.01" className={field} value={value} onChange={(e) => set(e.target.value)} /></label>)}</div>
          <Button disabled={!scope.trim() || [labor, materials, fee].some((amount) => !/^\d+(?:\.\d{1,2})?$/.test(amount))} onClick={() => save({ ...base, kind: "revise_quote", duration_minutes: duration, quoteUsd: { labor, materials, fee, scope, exclusions } })}>Submit quote</Button></>}
        {(role === "vendor" || role === "resident") && <><label className="block">Window start (Pacific)<input type="datetime-local" className={field} value={start} onChange={(e) => setStart(e.target.value)} /></label><label className="block">Window end (Pacific)<input type="datetime-local" className={field} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          {role === "vendor" && <label className="block">Duration (minutes)<CountStepper value={duration} min={15} max={480} step={15} label="Visit duration in minutes" onChange={setDuration} /></label>}
          {extraWindows.map((w, i) => <div key={i} className="grid gap-3 sm:grid-cols-2"><label>Window {i + 2} start (Pacific)<input type="datetime-local" className={field} value={w.startIso} onChange={e => setExtraWindows(all => all.map((item, n) => n === i ? {...item, startIso:e.target.value} : item))} /></label><label>Window {i + 2} end (Pacific)<input type="datetime-local" className={field} value={w.endIso} onChange={e => setExtraWindows(all => all.map((item, n) => n === i ? {...item, endIso:e.target.value} : item))} /></label></div>)}
          <Button variant="outline" disabled={extraWindows.length >= 19} onClick={() => setExtraWindows(all => [...all, {startIso:"",endIso:""}])}>Add window</Button>
          <Button onClick={() => save({ ...base, kind: role === "vendor" ? "submit_vendor_windows" : "submit_resident_windows", time_zone: "America/Los_Angeles", windows: [{ startIso: start, endIso: end }, ...extraWindows], ...(role === "vendor" ? { duration_minutes: duration } : {}) })}>Save windows</Button>
          {p.selected_start_at && <Button onClick={() => save({ ...base, kind: role === "vendor" ? "confirm_vendor" : "confirm_resident" })}>Agree to {formatPacificDateTime(p.selected_start_at)} Pacific</Button>}</>}
        {role === "manager" && <><label className="block">Visit start (Pacific)<input type="datetime-local" className={field} value={start} onChange={(e) => setStart(e.target.value)} /></label><Button onClick={() => save({ ...base, kind: "select_time", time_zone: "America/Los_Angeles", selected_start_iso: start })}>Propose time</Button><div className="flex flex-wrap gap-2"><Button disabled={p.status !== "ready"} onClick={() => save({ ...base, kind: "approve_manager" })}>Approve ${(coordinationQuote(p) ? quoteTotalCents(p.visit_type, coordinationQuote(p)!) / 100 : 0).toFixed(2)} and book</Button><Button variant="outline" onClick={() => save({ ...base, kind: "decline_manager" })}>Decline proposal</Button><label className="w-full">Reason<input className={field} value={reason} onChange={(e) => setReason(e.target.value)} /></label><Button variant="outline" onClick={() => save({ ...base, kind: "request_revision", reason })}>Request revision</Button><Button variant="outline" onClick={() => save({ ...base, kind: "take_over", reason })}>Take over coordination</Button></div></>}
      </div>}
      {role === "manager" && p.status === "approved" && <div className="p-3"><Button variant="outline" onClick={() => save({ ...base, kind: "cancel" })}>Cancel visit</Button></div>}
    </PortalSettingsGroup>; })}
  </PortalSettingsSection></div>;
}
