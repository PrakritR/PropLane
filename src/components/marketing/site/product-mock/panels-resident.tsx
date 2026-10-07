"use client";

/**
 * The resident portal's tabs for the home page demo — My home, Applications,
 * Lease, Payments, Services, Forms, Communication — drawn for one resident
 * (Liam Foster, Alder House · Room 1) from the shared "Seattle Homes"
 * fixtures. Each mirrors its real screen's tab names, command bar and row
 * anatomy (`resident-move-in-panel.tsx`, `resident-applications-panel.tsx`,
 * `resident-lease-list.tsx`, `resident-payments-panel.tsx`,
 * `resident-services-panel.tsx`, `move-in-forms/resident-move-in-forms.tsx`,
 * `resident-communication.tsx`). The real panels fetch on mount, so the rows
 * and cards are composed from the same presentational pieces instead.
 */

import { useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, ClipboardCheck, Clock, FileText, Home, Lock, Wrench } from "lucide-react";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  APPLICATION_ROWS,
  PAYMENT_ROWS,
  RESIDENT_CONVERSATIONS,
  RESIDENT_FORMS,
  RESIDENT_HOME,
  RESIDENT_NAME,
  SERVICE_ROWS,
  type ResidentFormFixture,
} from "@/components/marketing/site/product-mock/fixtures";
import { countBy, FixtureInboxScreen, FixtureListScreen, FixtureMenuItems, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { FixtureField, FixtureSheet, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";

const CARD = "rounded-xl border border-border bg-card";

type Detail = { title: string; fields: Array<[string, string]>; primary?: string };

function DetailSheet({ detail, onClose, onPrimary }: { detail: Detail | null; onClose: () => void; onPrimary?: () => void }) {
  return (
    <FixtureSheet open={!!detail} title={detail?.title ?? ""} onClose={onClose} primaryLabel={detail?.primary} onPrimary={onPrimary}>
      {detail?.fields.map(([label, value]) => (
        <FixtureField key={label} label={label} value={value} />
      ))}
    </FixtureSheet>
  );
}

/* ───────────────────────────── My home ───────────────────────────── */

const HOME_TABS = [
  { id: "placement", label: "Your placement" },
  { id: "details", label: "Move-in details" },
  { id: "roommates", label: "Roommates" },
  { id: "inspections", label: "Inspections" },
];

function DetailField({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">{label}</p>
      <p className="mt-1 truncate text-[15px] font-semibold text-foreground">{value}</p>
      {sub ? <p className="truncate text-[12.5px] text-muted">{sub}</p> : null}
    </div>
  );
}

function InfoCard({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <section className={`${CARD} p-4`}>
      <h3 className="text-[14px] font-bold text-foreground">{title}</h3>
      <dl className="mt-2 divide-y divide-border/60">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 text-right font-medium text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const CHECKLIST = ["Lease signed", "Move-in charges paid", "Move-in inspection photographed"];
const SHARING = ["My name", "My room", "My email address", "My phone number"];

export function ResidentHomePanel() {
  const [tab, setTab] = useState("placement");
  const [shared, setShared] = useState<Record<string, boolean>>({ "My name": true, "My room": true, "My email address": false, "My phone number": false });
  const { show, node: toastNode } = useFixtureToast();

  return (
    <ProductWindow path="/resident/move-in">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ManagerPortalPageShell title="My home">
          <PortalListControlStack
            variant="command"
            destinationRow={
              <LocalDestinationNav appearance="command" ariaLabel="My home" items={HOME_TABS} activeId={tab} onChange={setTab} />
            }
          />
          <div className="mt-3">
          {tab === "placement" ? (
            <div className="flex flex-col gap-3">
              <div className={`${CARD} grid grid-cols-1 gap-4 p-4 sm:grid-cols-3`}>
                <DetailField label="Assigned room" value={RESIDENT_HOME.room} />
                <DetailField label="Property" value={RESIDENT_HOME.property} sub={RESIDENT_HOME.address} />
                <DetailField label="Move-in date" value={RESIDENT_HOME.moveIn} />
              </div>
              <div className={`${CARD} divide-y divide-border/60`}>
                {CHECKLIST.map((item) => (
                  <div key={item} className="flex items-center gap-3 px-4 py-3">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{item}</span>
                    <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-emerald-600">Done</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "details" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <InfoCard
                title="Getting in"
                rows={[
                  ["Front door code", "4471#"],
                  ["Gate or building code", "None"],
                  ["Lockbox / key pickup", "Key in the front desk drawer"],
                  ["Parking", "Street parking on Alder St"],
                ]}
              />
              <InfoCard title="Wi-Fi" rows={[["Network name", "AlderHouse"], ["Password", "Shared at move-in"]]} />
              <InfoCard title="Trash & cleaning" rows={[["Trash day", "Tuesday"], ["Recycling", "Every other Tuesday"], ["Common areas", "Cleaned Fridays"]]} />
              <InfoCard
                title="House rules"
                rows={[
                  ["Quiet hours", "10 PM – 7 AM"],
                  ["Smoking", "Not allowed inside"],
                  ["Guests & overnight", "Tell your housemates first"],
                  ["Pets", "Ask your manager"],
                ]}
              />
            </div>
          ) : null}
          {tab === "roommates" ? (
            <div className="flex flex-col gap-3">
              <section className={`${CARD} p-4`}>
                <h3 className="text-[14px] font-bold text-foreground">What housemates can see</h3>
                <table className="mt-2 w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-[0.06em] text-muted">
                      <th className="py-1.5 font-bold">Detail</th>
                      <th className="py-1.5 text-right font-bold">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {SHARING.map((detail) => (
                      <tr key={detail}>
                        <td className="py-2 text-foreground">{detail}</td>
                        <td className="py-2 text-right">
                          <input
                            type="checkbox"
                            aria-label={`Share ${detail.toLowerCase()}`}
                            checked={shared[detail]}
                            onChange={(e) => setShared((s) => ({ ...s, [detail]: e.target.checked }))}
                            className="size-4 accent-[var(--btn-primary)]"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <p className={`${CARD} px-4 py-6 text-center text-[13px] text-muted`}>No other residents are listed for your household yet.</p>
            </div>
          ) : null}
          {tab === "inspections" ? (
            <PortalRecordListSurface isEmpty={false} emptyCard={{ title: "No inspections yet" }} bulkActions={<FixtureMenuItems toast={show} items={["Open"]} />}>
              <PortalApplicantRecordRow
                name="Move-in inspection"
                tileIcon={ClipboardCheck}
                address={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}`}
                facts={<PortalRowFact icon={CheckCircle2}>Photos added Aug 1</PortalRowFact>}
                onSelectedChange={() => undefined}
                onOpen={() => show("Move-in inspection (sample)")}
                dataAttr="resident-inspection-row"
              />
            </PortalRecordListSurface>
          ) : null}
          </div>
        </ManagerPortalPageShell>
      </div>
      {toastNode}
    </ProductWindow>
  );
}

/* ───────────────────────────── Applications ───────────────────────────── */

const APPLICATION_TABS = [
  { id: "sent", label: "Sent" },
  { id: "approved", label: "Approved" },
  { id: "denied", label: "Denied" },
];
const APPLICATION_TAB_OF: Record<string, string> = { incomplete: "sent", pending: "sent", approved: "approved", rejected: "denied" };

export function ResidentApplicationsPanel() {
  const mine = useMemo(() => APPLICATION_ROWS.filter((a) => a.name === RESIDENT_NAME), []);
  const counts = useMemo(() => countBy(mine, (a) => APPLICATION_TAB_OF[a.bucket]!, ["sent", "approved", "denied"]), [mine]);
  const [tab, setTab] = useState("approved");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const rows = mine.filter((a) => APPLICATION_TAB_OF[a.bucket] === tab && matchesSearch(search, a.property, a.unit));

  return (
    <FixtureListScreen
      path="/resident/applications"
      title="Applications"
      tabs={APPLICATION_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Application status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search applications"
      primary={{ label: "Add application", onClick: () => show("Add application") }}
      isEmpty={rows.length === 0}
      emptyTitle={tab === "sent" ? "Nothing sent" : tab === "approved" ? "Nothing approved" : "Nothing denied"}
      emptySection="applications"
      menu={<FixtureMenuItems toast={show} items={["Open"]} />}
      overlay={
        <>
          <DetailSheet detail={detail} onClose={() => setDetail(null)} />
          {toastNode}
        </>
      }
    >
      {rows.map((a) => (
        <PortalApplicantRecordRow
          key={a.id}
          name={a.property}
          tileIcon={Home}
          address={`${a.unit} · Long-term`}
          facts={<PortalRowFact icon={CalendarDays}>{a.submitted}</PortalRowFact>}
          onSelectedChange={() => undefined}
          onOpen={() => setDetail({ title: a.property, fields: [["Room", a.unit], ["Submitted", a.submitted], ["Stage", a.stage]] })}
          dataAttr="resident-application-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Lease ───────────────────────────── */

const LEASE_TABS = [
  { id: "pending", label: "Pending" },
  { id: "signed", label: "Signed" },
];

export function ResidentLeasePanel() {
  const [tab, setTab] = useState("signed");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const leases = [{ id: "lease-liam", bucket: "signed", property: RESIDENT_HOME.property, signed: RESIDENT_HOME.leaseSigned }];
  const counts = countBy(leases, (l) => l.bucket, ["pending", "signed"]);
  const rows = leases.filter((l) => l.bucket === tab && matchesSearch(search, "Lease agreement", l.property));

  return (
    <FixtureListScreen
      path="/resident/lease/signed"
      title="Lease"
      tabs={LEASE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Lease status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search leases"
      isEmpty={rows.length === 0}
      emptyTitle="No pending leases yet"
      emptySection="lease"
      menu={<FixtureMenuItems toast={show} items={["Open", "Download"]} />}
      overlay={
        <>
          <DetailSheet detail={detail} onClose={() => setDetail(null)} />
          {toastNode}
        </>
      }
    >
      {rows.map((l) => (
        <PortalApplicantRecordRow
          key={l.id}
          name="Lease agreement"
          tileIcon={FileText}
          address={`${l.property} · Signed · ${l.signed}`}
          onSelectedChange={() => undefined}
          onOpen={() =>
            setDetail({
              title: "Lease agreement",
              fields: [
                ["Rent", `${RESIDENT_HOME.rent} per month`],
                ["Property", `${l.property} · ${RESIDENT_HOME.room}`],
                ["Your signature", "Signed"],
                ["Manager signature", "Signed"],
              ],
            })
          }
          dataAttr="resident-lease-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Payments ───────────────────────────── */

const PAYMENT_TABS = [
  { id: "pending", label: "Upcoming" },
  { id: "overdue", label: "Due" },
  { id: "paid", label: "Paid" },
];

export function ResidentPaymentsPanel() {
  const mine = useMemo(() => PAYMENT_ROWS.filter((p) => p.resident === RESIDENT_NAME), []);
  const counts = useMemo(() => countBy(mine, (p) => p.bucket, ["pending", "overdue", "paid"]), [mine]);
  const [tab, setTab] = useState("overdue");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const rows = mine.filter((p) => p.bucket === tab && matchesSearch(search, p.chargeTitle, p.property));

  return (
    <FixtureListScreen
      path="/resident/payments"
      title="Payments"
      tabs={PAYMENT_TABS.map((t) => ({ ...t, count: counts[t.id], alert: t.id === "overdue" && counts[t.id]! > 0 }))}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Charges"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search payments"
      above={
        <div className={`${CARD} mb-2 flex flex-wrap items-center justify-between gap-3 px-4 py-3`}>
          <div className="min-w-0">
            <p className="text-[14px] font-bold text-foreground">Autopay</p>
            <p className="truncate text-[13px] text-foreground/80">Off</p>
          </div>
          <div className="min-w-0 text-[13px]">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">Pays with</p>
            <button type="button" onClick={() => show("Add payment method")} className="font-semibold text-primary">
              Add payment method
            </button>
          </div>
          {tab !== "paid" && rows.length > 0 ? (
            <button
              type="button"
              onClick={() => show("Payment sent (sample)")}
              className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-[12.5px] font-bold text-white"
            >
              Pay all
            </button>
          ) : null}
        </div>
      }
      isEmpty={rows.length === 0}
      emptyTitle={tab === "overdue" ? "No overdue charges" : tab === "pending" ? "No upcoming charges" : "No payments in this tab yet"}
      emptySection="payments"
      menu={<FixtureMenuItems toast={show} items={tab === "paid" ? [] : ["Pay"]} />}
      overlay={
        <>
          <DetailSheet detail={detail} onClose={() => setDetail(null)} onPrimary={() => { show("Payment sent (sample)"); setDetail(null); }} />
          {toastNode}
        </>
      }
    >
      {rows.map((p) => (
        <PortalApplicantRecordRow
          key={p.id}
          name={p.chargeTitle}
          tileIcon={FileText}
          address={`${p.property} · ${p.due}`}
          amount={p.amount}
          onSelectedChange={() => undefined}
          onOpen={() =>
            setDetail({
              title: p.chargeTitle,
              fields: [["Property", p.property], ["Due", p.due], ["Amount", p.amount]],
              primary: p.bucket === "paid" ? undefined : `Pay ${p.amount}`,
            })
          }
          dataAttr="resident-payment-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Services ───────────────────────────── */

const SERVICE_TABS = [
  { id: "open", label: "Open" },
  { id: "assigned", label: "Assigned" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
];
const SERVICE_TAB_OF: Record<string, string> = { open: "open", scheduled: "scheduled", done: "completed", declined: "completed" };

export function ResidentServicesPanel() {
  const mine = useMemo(() => SERVICE_ROWS.filter((s) => s.resident === RESIDENT_NAME), []);
  const counts = useMemo(() => countBy(mine, (s) => SERVICE_TAB_OF[s.state]!, ["open", "assigned", "scheduled", "completed"]), [mine]);
  const [tab, setTab] = useState("open");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const rows = mine.filter((s) => SERVICE_TAB_OF[s.state] === tab && matchesSearch(search, s.title, s.property));

  return (
    <FixtureListScreen
      path="/resident/services"
      title="Services"
      tabs={SERVICE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={setTab}
      tabAriaLabel="Service status"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search services"
      primary={{ label: "Add service", onClick: () => show("Add service") }}
      isEmpty={rows.length === 0}
      emptyTitle={tab === "assigned" ? "Nothing assigned" : "No services in this status yet"}
      emptySection="services"
      menu={<FixtureMenuItems toast={show} items={tab === "open" ? ["Send reminder", "Delete"] : ["Delete"]} />}
      overlay={
        <>
          <DetailSheet detail={detail} onClose={() => setDetail(null)} />
          {toastNode}
        </>
      }
    >
      {rows.map((s) => (
        <PortalApplicantRecordRow
          key={s.id}
          name={s.title}
          tileIcon={Wrench}
          address={`${s.property} · ${RESIDENT_HOME.room}`}
          facts={<PortalRowFact icon={CalendarDays}>{s.detail}</PortalRowFact>}
          onSelectedChange={() => undefined}
          onOpen={() => setDetail({ title: s.title, fields: [["Property", `${s.property} · ${RESIDENT_HOME.room}`], ["Status", s.detail]] })}
          dataAttr="resident-service-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Forms ───────────────────────────── */

const FORM_TABS = [
  { id: "pending", label: "Pending" },
  { id: "completed", label: "Completed" },
];

export function ResidentFormsPanel() {
  const counts = useMemo(() => countBy(RESIDENT_FORMS, (f) => f.bucket, ["pending", "completed"]), []);
  const [tab, setTab] = useState<ResidentFormFixture["bucket"]>("pending");
  const { show, node: toastNode } = useFixtureToast();
  const rows = RESIDENT_FORMS.filter((f) => f.bucket === tab);

  return (
    <FixtureListScreen
      path="/resident/forms"
      title="Forms"
      tabs={FORM_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => setTab(id as ResidentFormFixture["bucket"])}
      tabAriaLabel="Forms"
      isEmpty={rows.length === 0}
      emptyTitle={tab === "pending" ? "No pending forms" : "No completed forms"}
      emptySection="forms"
      menu={<FixtureMenuItems toast={show} items={[tab === "pending" ? "Fill out" : "View"]} />}
      overlay={toastNode}
    >
      {rows.map((f) => (
        <PortalApplicantRecordRow
          key={f.id}
          name={f.title}
          tileIcon={FileText}
          address={f.place}
          facts={
            <>
              <PortalRowFact icon={f.bucket === "completed" ? CheckCircle2 : Clock}>{f.fact}</PortalRowFact>
              {f.blocks ? <PortalRowFact icon={Lock}>{f.blocks}</PortalRowFact> : null}
            </>
          }
          omitActionView
          onSelectedChange={() => undefined}
          onOpen={() => show(f.bucket === "pending" ? `${f.title}: one question per screen (sample)` : `${f.title} (sample)`)}
          dataAttr="resident-form-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Communication ───────────────────────────── */

export function ResidentCommunicationPanel() {
  return <FixtureInboxScreen path="/resident/communication/active" conversations={RESIDENT_CONVERSATIONS} selfName={RESIDENT_NAME} />;
}
