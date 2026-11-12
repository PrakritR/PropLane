"use client";

import { Check, Landmark, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal } from "@/components/ui/modal";
import { directRentFromLedger, rollupChannelIncome, type ChannelIncomeRow, type IncomeGroupBy } from "@/lib/channel-finance/income";
import { FINANCE_PLATFORM_LABEL } from "@/lib/channel-finance/types";
import { formatCentsAsUsd } from "@/lib/money-label-totals";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";

type Room = { propertyId: string; propertyLabel: string; roomId: string; roomLabel: string };
type MailSummary = { platform: "airbnb" | "booking_com"; lastReceivedAt: string | null; flagged: { id: string; subject: string; receivedAt: string }[] };
type Overview = { rows: ChannelIncomeRow[]; rooms: Room[]; mail: MailSummary[] };
type ImportResult = {
  committed: boolean;
  ready: number;
  errors: { line: number; message: string }[];
  errorCount: number;
  skipped: number;
  fatal: string | null;
  saved?: number;
  needsRoom?: number;
  failed?: number;
};

const GROUPS = [
  { value: "house", label: "House" },
  { value: "room", label: "Room" },
  { value: "month", label: "Month" },
];
const usd = (cents: number | null) => (cents === null ? "-" : formatCentsAsUsd(cents));
const day = (ymd: string | null) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");

async function send(url: string, init: RequestInit): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

function rowPlace(row: ChannelIncomeRow): string {
  return [row.propertyLabel, row.roomLabel, row.checkIn && row.checkOut ? `${day(row.checkIn)} – ${day(row.checkOut)}` : ""].filter(Boolean).join(" · ");
}

/** The list-action icon on Incoming payments that opens the channel income report (Airbnb, Booking.com and direct rent, per house / room / month). */
export function ChannelIncomeAction({ ledgerRows }: { ledgerRows: readonly DemoManagerPaymentLedgerRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PortalIconAction icon={Landmark} label="Channel income" data-attr="payments-channel-income" onClick={() => setOpen(true)} />
      {open ? <ChannelIncomeModal ledgerRows={ledgerRows} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ChannelIncomeModal({ ledgerRows, onClose }: { ledgerRows: readonly DemoManagerPaymentLedgerRow[]; onClose: () => void }) {
  const { showToast } = useAppUi();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [groupBy, setGroupBy] = useState<IncomeGroupBy>("house");
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/portal/channel-finance", { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error("load");
      setOverview((await res.json()) as Overview);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (body: Record<string, unknown>, done: string) => {
    const { ok, data } = await send("/api/portal/channel-finance", { method: "PATCH", body: JSON.stringify(body) });
    showToast(ok ? done : String(data.error ?? "Could not save."));
    if (ok) await load();
  };

  const direct = useMemo(() => directRentFromLedger(ledgerRows), [ledgerRows]);
  const report = useMemo(() => (overview ? rollupChannelIncome(overview.rows, direct, { groupBy }) : null), [overview, direct, groupBy]);
  const unpaid = overview?.rows.filter((r) => r.status === "overdue" || r.status === "pending") ?? [];
  const needsRoom = overview?.rows.filter((r) => r.status === "needs_room") ?? [];
  const needsReview = overview?.rows.filter((r) => r.status === "needs_review") ?? [];
  const flaggedMail = overview?.mail.flatMap((m) => m.flagged.map((f) => ({ ...f, platform: m.platform }))) ?? [];
  const roomOptions = (overview?.rooms ?? []).map((r) => ({ value: `${r.propertyId}::${r.roomId}`, label: `${r.propertyLabel} · ${r.roomLabel}` }));

  return (
    <Modal open title="Channel income" onClose={onClose} dataAttr="channel-income-modal">
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-3">
          <div className="w-40">
            <FieldSingleSelect label="Group by" options={GROUPS} value={groupBy} onChange={(v) => setGroupBy(v as IncomeGroupBy)} dataAttr="channel-income-group" />
          </div>
          <PortalIconAction icon={Upload} label="Import CSV" data-attr="channel-income-import" onClick={() => setImportOpen((v) => !v)} />
        </div>

        {importOpen ? <ImportSection onDone={() => void load()} /> : null}

        {failed ? <p className="text-sm text-danger">Could not load channel income.</p> : null}
        {!overview && !failed ? <p className="text-sm text-muted">Loading…</p> : null}

        {report ? (
          <section data-attr="channel-income-report" className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm tabular-nums">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 pr-3 font-medium">{GROUPS.find((g) => g.value === groupBy)?.label}</th>
                  <th className="py-2 pr-3 text-right font-medium">Airbnb</th>
                  <th className="py-2 pr-3 text-right font-medium">Booking.com</th>
                  <th className="py-2 pr-3 text-right font-medium">Direct rent</th>
                  <th className="py-2 pr-3 text-right font-medium">Gross</th>
                  <th className="py-2 pr-3 text-right font-medium">Fees</th>
                  <th className="py-2 text-right font-medium">Total in</th>
                </tr>
              </thead>
              <tbody>
                {[...report.lines, report.grand].map((line, i, all) => (
                  <tr key={line.key} className={i === all.length - 1 ? "border-t border-border font-semibold" : "border-t border-border/50"}>
                    <td className="py-2 pr-3">{line.label}</td>
                    <td className="py-2 pr-3 text-right">{usd(line.airbnb.payoutCents)}</td>
                    <td className="py-2 pr-3 text-right">{usd(line.booking_com.payoutCents)}</td>
                    <td className="py-2 pr-3 text-right">{usd(line.directRentCents)}</td>
                    <td className="py-2 pr-3 text-right">{usd(line.airbnb.grossCents + line.booking_com.grossCents)}</td>
                    <td className="py-2 pr-3 text-right">{usd(line.airbnb.feeCents + line.booking_com.feeCents)}</td>
                    <td className="py-2 text-right">{usd(line.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <RowSection title="Booked, not paid out yet" rows={unpaid} dataAttr="channel-income-unpaid" render={(row) => <span className={row.status === "overdue" ? "text-danger" : ""}>{row.status === "overdue" ? "Overdue · " : ""}{usd(row.payoutCents)}</span>} />

        <RowSection
          title="Needs a room"
          rows={needsRoom}
          dataAttr="channel-income-needs-room"
          render={(row) => (
            <div className="w-64">
              <FieldSingleSelect
                label="Room"
                hideLabel
                placeholder="Assign a room"
                options={roomOptions}
                value=""
                dataAttr="channel-income-assign-room"
                onChange={(v) => {
                  const [propertyId, roomId] = v.split("::");
                  if (row.recordId) void act({ action: "assign_room", id: row.recordId, propertyId, roomId }, "Room assigned.");
                }}
              />
            </div>
          )}
        />

        <RowSection
          title="Needs review"
          rows={needsReview}
          dataAttr="channel-income-needs-review"
          render={(row) => (
            <span className="inline-flex items-center gap-1">
              <span className="tabular-nums">{usd(row.payoutCents)}</span>
              <PortalIconAction icon={Check} label="Confirm amounts" data-attr="channel-income-confirm" onClick={() => row.recordId && void act({ action: "confirm", id: row.recordId }, "Confirmed.")} />
              <PortalIconAction icon={Trash2} label="Delete" tone="danger" data-attr="channel-income-delete" onClick={() => row.recordId && void act({ action: "delete", id: row.recordId }, "Deleted.")} />
            </span>
          )}
        />

        {flaggedMail.length > 0 ? (
          <section data-attr="channel-income-flagged-mail">
            <h3 className="mb-2 text-sm font-semibold">Mail not read</h3>
            {flaggedMail.map((mail) => (
              <div key={mail.id} className="flex items-center justify-between gap-3 border-t border-border/50 py-2 text-sm">
                <span className="min-w-0 truncate">{FINANCE_PLATFORM_LABEL[mail.platform]} · {mail.subject}</span>
                <PortalIconAction icon={X} label="Dismiss" data-attr="channel-income-dismiss-mail" onClick={() => void act({ action: "dismiss_mail", id: mail.id }, "Dismissed.")} />
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

function RowSection({ title, rows, render, dataAttr }: { title: string; rows: ChannelIncomeRow[]; render: (row: ChannelIncomeRow) => React.ReactNode; dataAttr: string }) {
  if (rows.length === 0) return null;
  return (
    <section data-attr={dataAttr}>
      <h3 className="mb-2 text-sm font-semibold">{title} · {rows.length}</h3>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-3 border-t border-border/50 py-2 text-sm">
          <div className="min-w-0">
            <div className="truncate font-medium">{FINANCE_PLATFORM_LABEL[row.platform]} · {row.guestLabel || row.confirmationCode || "Guest"}</div>
            <div className="truncate text-muted">{rowPlace(row)}</div>
          </div>
          <div className="shrink-0">{render(row)}</div>
        </div>
      ))}
    </section>
  );
}

function ImportSection({ onDone }: { onDone: () => void }) {
  const { showToast } = useAppUi();
  const [platform, setPlatform] = useState<"airbnb" | "booking_com">("airbnb");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (commit: boolean) => {
    const { ok, data } = await send("/api/portal/channel-finance/import", { method: "POST", body: JSON.stringify({ platform, csv, commit }) });
    if (!ok) {
      showToast(String(data.error ?? "Could not read that file."));
      return;
    }
    setResult(data as unknown as ImportResult);
    if (commit) {
      showToast(`Imported ${String(data.saved ?? 0)} ${data.saved === 1 ? "booking" : "bookings"}.`);
      onDone();
    }
  };

  return (
    <section data-attr="channel-income-import-panel" className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-end gap-3">
        <div className="w-44">
          <FieldSingleSelect label="Channel" options={[{ value: "airbnb", label: "Airbnb" }, { value: "booking_com", label: "Booking.com" }]} value={platform} onChange={(v) => { setPlatform(v as "airbnb" | "booking_com"); setResult(null); }} dataAttr="channel-income-import-platform" />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setFileName(file.name);
            const text = await file.text();
            setCsv(text);
            setResult(null);
            const { ok, data } = await send("/api/portal/channel-finance/import", { method: "POST", body: JSON.stringify({ platform, csv: text, commit: false }) });
            if (ok) setResult(data as unknown as ImportResult);
            else showToast(String(data.error ?? "Could not read that file."));
          }}
        />
        <PortalIconAction icon={Upload} label="Choose CSV file" data-attr="channel-income-choose-file" onClick={() => fileRef.current?.click()} />
        {fileName ? <span className="min-w-0 truncate text-sm">{fileName}</span> : null}
      </div>
      {result ? (
        <div className="space-y-2 text-sm" data-attr="channel-income-import-preview">
          {result.fatal ? <p className="text-danger">{result.fatal}</p> : <p>{result.ready} ready · {result.skipped} skipped · {result.errorCount} with errors</p>}
          {result.errors.slice(0, 8).map((error) => (
            <p key={`${error.line}-${error.message}`} className="text-danger">Line {error.line}: {error.message}</p>
          ))}
          {result.committed && !result.fatal ? <p>Saved {result.saved}{result.needsRoom ? ` · ${result.needsRoom} need a room` : ""}</p> : null}
          {!result.committed && !result.fatal && result.ready > 0 ? (
            <Button data-attr="channel-income-import-commit" onClick={() => run(true)}>
              Import {result.ready}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
