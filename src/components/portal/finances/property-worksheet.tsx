"use client";
import { useEffect, useState } from "react";
import { Download, Pencil } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { CAPITAL_FIELDS, type PropertyWorksheet as Worksheet, type propertyCashGroups } from "@/lib/reports/property-worksheet";
import { centsToUsd } from "@/lib/reports/money";
import type { buildRentDueSummary } from "@/lib/reports/rent-due";
type Model = { properties: { id: string; label: string }[]; worksheet: Worksheet; groups: ReturnType<typeof propertyCashGroups>; groupTotals: Record<string, number>; cashCents: number; depositCents: number; normalizedCents: number | null; differenceCents: number | null; editable: boolean };
const label = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
const money = (value: number | null | undefined) => value == null ? "Not set" : centsToUsd(value);
export function PropertyFinanceWorksheet({ onAdd }: { onAdd: (propertyId: string) => void }) {
  const [property, setProperty] = useState(""); const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [model, setModel] = useState<Model | null>(null); const [rooms, setRooms] = useState<ReturnType<typeof buildRentDueSummary>["rooms"]>({});
  const [error, setError] = useState(""); const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<"capital" | "reported" | null>(null); const [values, setValues] = useState<Record<string, string>>({}); const [convention, setConvention] = useState("income_positive");
  const query = new URLSearchParams({ period, ...(property ? { propertyId: property } : {}) }).toString();
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try { const res = await fetch(`/api/reports/property-worksheet?${query}`); const data = await res.json(); if (!res.ok) throw new Error(data.error); if (!cancelled) { setModel(data); setError(""); }
        const roomRes = await fetch(`/api/reports/rent-due?${query}`); const roomData = await roomRes.json(); if (!roomRes.ok) throw new Error(roomData.error); if (!cancelled) setRooms(roomData.rooms);
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load worksheet."); }
    } void load(); return () => { cancelled = true; };
  }, [query, revision]);
  const open = (kind: "capital" | "reported") => { setEditing(kind); setError(""); setValues(kind === "capital" ? Object.fromEntries(Object.entries(model?.worksheet.capital ?? {}).map(([k,v]) => [k, String(v / 100)])) : { amount: model?.worksheet.reported?.[period]?.amountCents == null ? "" : String(model.worksheet.reported[period].amountCents! / 100) }); setConvention(model?.worksheet.reported?.[period]?.convention ?? "income_positive"); };
  async function save() {
    try {
      const cents = (value: string) => { if (!value.trim()) return null; if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error("Enter amounts with at most two decimals."); const amount = Math.round(Number(value) * 100); if (!Number.isSafeInteger(amount)) throw new Error("Amount too large."); return amount; };
      const body = editing === "capital" ? { kind: editing, values: Object.fromEntries(CAPITAL_FIELDS.map(key => [key, cents(values[key] || "")])) } : { kind: editing, period, amountCents: cents(values.amount || ""), convention };
      const res = await fetch("/api/reports/property-worksheet", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, propertyId: property }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setEditing(null); setRevision(n => n + 1);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
  }
  const fact = (name: string, value: number | null | undefined) => <div key={name} className="flex justify-between gap-4 py-2"><span>{name}</span><strong className="tabular-nums">{money(value)}</strong></div>;
  const section = (title: string, body: React.ReactNode, action?: React.ReactNode) => <section className="rounded-xl border border-border bg-card p-4"><header className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{title}</h2>{action}</header>{body}</section>;
  return <div className="space-y-4"><div className="flex flex-wrap items-center gap-3"><FieldSingleSelect label="Property" value={property} onChange={(v) => { setProperty(v); setModel(null); }} options={[{ value: "", label: "All properties" }, { value: "_unallocated", label: "Unallocated" }, ...(model?.properties.map((p) => ({ value: p.id, label: p.label })) ?? [])]} /><input type="number" min="1900" max="9999" aria-label="Year" className="w-24 rounded-lg border border-border bg-card p-2" value={period.slice(0,4)} onChange={e => setPeriod(e.target.value + (period.length > 4 ? period.slice(4) : ""))} /><FieldSingleSelect label="Month" value={period.slice(5)} onChange={(v) => setPeriod(period.slice(0,4) + (v ? `-${v}` : ""))} options={[{ value: "", label: "All months" }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1).padStart(2, "0"), label: new Date(2026, i, 1).toLocaleDateString("en-US", { month: "long" }) }))]} /><PortalIconAction icon={Download} label="Download filtered CSV" onClick={() => window.location.assign(`/api/reports/property-worksheet?${query}&format=csv`)} /><button type="button" onClick={() => onAdd(property === "_unallocated" ? "" : property)} className="grid size-10 place-items-center rounded-full bg-primary text-white" aria-label="Add financial entry">+</button></div>
    {error ? <p role="alert">{error}</p> : null}{!model ? <p role="status">Loading worksheet…</p> : <>
      {section("Settled cash movement", <>{Object.entries(model.groupTotals).map(([name, amount]) => fact(name, amount))}{fact("Net cash movement", model.cashCents)}{fact("Deposits held · period end", model.depositCents)}</>)}
      {section("Reconciliation", <>{fact("Computed cash movement", model.cashCents)}{fact("Reported source total", model.worksheet.reported?.[period]?.amountCents)}<div>Source convention: {model.worksheet.reported?.[period]?.convention?.replaceAll("_", " ") || "Not set"}</div>{fact("Normalized reported total", model.normalizedCents)}{fact("Difference", model.differenceCents)}</>, model.editable && <PortalIconAction icon={Pencil} label="Edit reported total" onClick={() => open("reported")} />)}
      {property && property !== "_unallocated" ? section("Capital", <>{CAPITAL_FIELDS.map(key => fact(label(key), model.worksheet.capital?.[key]))}{fact("Profit", null)}</>, model.editable && <PortalIconAction icon={Pencil} label="Edit capital" onClick={() => open("capital")} />) : null}
      {Object.entries(model.groups).map(([group,categories]) => <div key={group}>{section(group, Object.entries(categories).map(([category, bucket]) => <details key={category} className="border-t border-border py-2"><summary className="cursor-pointer font-medium">{category} · {money(bucket.amountCents)}</summary>{Object.entries(bucket.months).sort(([a],[b]) => a.localeCompare(b)).map(([month, monthData]) => <div key={month}><div className="flex justify-between bg-accent/30 py-2 text-sm"><strong>{month}</strong><strong>{money(monthData.amountCents)}</strong></div>{monthData.rows.map(row => <div key={String(row.id)} className="flex justify-between gap-4 py-3 text-sm"><div>{String(row.description)}<div>{String(row.date)} · {String(row.property || "Unallocated")}</div><span className="text-xs text-muted">{String(row.source || "Ledger")} · {String(row.id)}</span></div><strong>{money(Number(row.amountCents))}</strong></div>)}</div>)}</details>))}</div>)}
      {section("Room charges · due period", Object.keys(rooms).length ? Object.entries(rooms).map(([room, categories]) => <details key={room}><summary>{room}</summary>{Object.entries(categories).map(([category, totals]) => <div className="flex flex-wrap justify-between gap-2 py-2 text-sm" key={category}><span>{label(category.replaceAll("_", " "))}</span><span>Paid {money(totals.paidCents)}</span><span>Outstanding {money(totals.outstandingCents)}</span></div>)}</details>) : <p>No room charges in this period.</p>)}
    </>}
    <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing === "capital" ? "Capital" : "Reported total"}>{(editing === "capital" ? CAPITAL_FIELDS : ["amount"]).map(key => <label key={key} className="block py-2">{key === "amount" ? "Source total" : label(key)}<input inputMode="decimal" className="mt-1 block w-full rounded-lg border border-border bg-card p-2" value={values[key] || ""} onChange={e => setValues(old => ({ ...old, [key]: e.target.value }))} /></label>)}{editing === "reported" ? <FieldSingleSelect label="Source convention" value={convention} onChange={setConvention} options={[{ value: "income_positive", label: "Income positive · expenses negative" }, { value: "expense_positive", label: "Expenses positive · income negative" }]} /> : null}{error ? <p role="alert">{error}</p> : null}<ModalFooter><Button onClick={save}>Save</Button></ModalFooter></Modal>
  </div>;
}
