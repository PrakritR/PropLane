"use client";

import { Banknote, CalendarDays, CheckCircle2, Clock, Download, Home, Landmark, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalStatStrip } from "@/components/portal/portal-stat-strip";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS, Modal, ModalFooter, PORTAL_MODAL_FORM_FIELD_CLASS } from "@/components/ui/modal";
import { centsToDollarsInput, parseDollarsToCents } from "@/lib/dollar-input";
import type { EarningsMonth, EarningsView } from "@/lib/managed-finance/earnings.server";
import { formatManagedUsd, managedMonthLabel } from "@/lib/managed-finance/format";
import { formatPacificDate } from "@/lib/pacific-time";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";

export const EARNINGS_URL = "/api/earnings";
/** The cheap "is there an Earnings page for me?" read: a single existence check, not the whole view. */
export const EARNINGS_PROBE_URL = "/api/earnings?probe=1";

export const EARNINGS_VIEWS = [
  { id: "upcoming", label: "Upcoming" },
  { id: "paid", label: "Paid" },
  { id: "reports", label: "Reports" },
  { id: "methods", label: "Payout methods" },
] as const;
export type EarningsViewId = (typeof EARNINGS_VIEWS)[number]["id"];

/** Is there anything to show? Earnings is drawn only for a person who holds a share (an owner seat, a team split, a vendor). */
export function earningsHasShare(view: Pick<EarningsView, "workspaces"> | null | undefined): boolean {
  return Boolean(view && view.workspaces.length > 0);
}

/**
 * Whether the signed-in account has an Earnings page: the tab is hidden for everyone with no share. Every manager who opens
 * Finances asks this, so it asks the probe — the full view reads the whole ledger history, a balance per workspace, twelve
 * statements and a live Stripe account, which is far too much to pay for one boolean.
 */
export function useEarningsAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    void sharedGet(EARNINGS_PROBE_URL).then((res) => {
      if (live) setAllowed(res.ok && (res.data as { hasShare?: boolean } | null)?.hasShare === true);
    });
    return () => {
      live = false;
    };
  }, []);
  return allowed;
}

const shortDate = (value: string) => formatPacificDate(value, { month: "short", day: "numeric" });

/** Bars for the last 12 months of net earnings. Plain divs sized from the figures: a pure function of the rows. */
export function MonthlyBars({ months }: { months: readonly EarningsMonth[] }) {
  const max = Math.max(1, ...months.map((m) => Math.max(0, m.netCents)));
  return (
    <div className="flex h-28 items-end gap-1.5 rounded-xl border border-border bg-card px-3 pb-2 pt-3" role="img" aria-label="Earnings by month" data-attr="earnings-chart">
      {months.map((m) => (
        <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${managedMonthLabel(m.month)}: ${formatManagedUsd(m.netCents)}`}>
          <div className="w-full rounded-t bg-primary" style={{ height: `${Math.max(2, Math.round((Math.max(0, m.netCents) / max) * 72))}px` }} />
          <span className="text-[10px] tabular-nums text-muted">{m.month.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function StatementBand({ label, count }: { label: string; count?: number }) {
  return (
    <p className="mb-1 px-1 text-[13px] font-semibold text-foreground">
      {label}
      {count !== undefined ? <span className="ml-1.5 font-medium tabular-nums text-muted">{count}</span> : null}
    </p>
  );
}

/** Finances › Earnings: a person's own PropLane balance, Upcoming / Paid / Reports / Payout methods (the Airbnb host Earnings page). */
export function EarningsPanel({ basePath = "/portal" }: { basePath?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params?.get("view") ?? "upcoming";
  const view: EarningsViewId = EARNINGS_VIEWS.some((v) => v.id === requested) ? (requested as EarningsViewId) : "upcoming";
  const [state, setState] = useState<{ data: EarningsView | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void sharedGet(EARNINGS_URL, { force: tick > 0 }).then((res) => {
      if (!live) return;
      if (res.ok) setState({ data: res.data as EarningsView, loading: false, error: null });
      else setState({ data: null, loading: false, error: (res.data as { error?: string } | null)?.error ?? "Request failed." });
    });
    return () => {
      live = false;
    };
  }, [tick]);
  const reload = useCallback(() => {
    invalidateSharedGets(EARNINGS_URL);
    setTick((n) => n + 1);
  }, []);
  const data = state.data;

  // Withdraw: one workspace's balance at a time (the ledger is per workspace for an owner or team member, one pool for a vendor).
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keyRef = useRef("");
  const targets = (data?.workspaces ?? []).filter((w) => w.balance.availableCents > 0);
  const targetRow = targets.find((w) => (w.workspaceId ?? "vendor") === target) ?? targets[0] ?? null;
  const openWithdraw = () => {
    keyRef.current = crypto.randomUUID();
    const first = targets[0];
    setTarget(first ? (first.workspaceId ?? "vendor") : "");
    setAmount(centsToDollarsInput(first?.balance.availableCents ?? 0));
    setError(null);
    setWithdrawOpen(true);
  };
  const withdraw = async () => {
    const amountCents = parseDollarsToCents(amount);
    if (!targetRow || amountCents === null) return void setError("Enter an amount, like 250.00.");
    setError(null);
    try {
      const res = await fetch("/api/earnings/withdraw", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: targetRow.role === "vendor" ? "vendor" : "owner", workspaceId: targetRow.workspaceId, amountCents, clientKey: keyRef.current }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; payoutAutomatic?: boolean; payoutPending?: boolean };
      if (!res.ok) return void setError(body.error ?? "Could not start the withdrawal.");
      setWithdrawOpen(false);
      setNotice(body.payoutAutomatic ? "On its way with your next automatic payout" : body.payoutPending ? "Your bank payout is being set up" : null);
      reload();
    } catch {
      setError("Could not start the withdrawal.");
    }
  };

  const tabs = EARNINGS_VIEWS.map((v) => ({ id: v.id, label: v.label, href: `${basePath}/financials/earnings?view=${v.id}` }));
  const downloadCsv = () => window.location.assign("/api/earnings?format=csv");

  if (state.loading && !data) return <PortalRecordListSurface loading dataAttr="earnings-loading" />;
  if (state.error) return <PortalRecordListSurface loadError="Couldn't load your earnings." onRetry={reload} dataAttr="earnings-error" />;
  if (!data || !earningsHasShare(data)) return <PortalRecordListSurface isEmpty emptyCard={{ title: "No earnings yet" }} dataAttr="earnings-empty" />;

  return (
    <div className="min-w-0 space-y-4 max-lg:space-y-3" data-attr="earnings">
      <div className="flex items-center justify-end gap-0.5">
        <PortalIconAction icon={Wallet} label="Withdraw" data-attr="earnings-withdraw" disabled={targets.length === 0 || data.onHold} onClick={openWithdraw} />
        <PortalIconAction icon={Download} label="Download report" data-attr="earnings-download" onClick={downloadCsv} />
      </div>
      {notice ? <p role="status" className="text-sm font-medium text-foreground" data-attr="earnings-notice">{notice}</p> : null}
      {data.onHold ? <p role="status" className="text-sm font-medium text-foreground" data-attr="earnings-hold">Withdrawals are on hold. PropLane support can tell you why.</p> : null}
      <PortalStatStrip
        size="lg"
        dataAttr="earnings-strip"
        items={[
          { id: "available", label: "Available", value: formatManagedUsd(data.totals.availableCents), tone: "ok" },
          { id: "pending", label: "Pending", value: formatManagedUsd(data.totals.pendingCents) },
          { id: "paid", label: "Paid out", value: formatManagedUsd(data.paid.reduce((s, w) => s + w.amountCents, 0)) },
          { id: "total", label: "Balance", value: formatManagedUsd(data.totals.balanceCents) },
        ]}
      />
      <PortalListControlStack className="mb-2" variant="command" stickyDestinations={false} destinations={tabs} activeDestinationId={view} destinationAriaLabel="Earnings" />

      {view === "upcoming" ? (
        <PortalRecordListSurface isEmpty={data.upcoming.length === 0} emptyCard={{ title: "Nothing clearing" }} dataAttr="earnings-upcoming">
          {data.upcoming.map((u) => (
            <PortalEntryRow
              key={u.id}
              tile={{ kind: "glyph", icon: Banknote }}
              title={u.label}
              place={[u.workspaceName, u.propertyLabel].filter(Boolean).join(" · ")}
              facts={[{ icon: Clock, label: `Clears ${shortDate(u.availableOn)}`, srLabel: "Clears" }]}
              figure={{ value: formatManagedUsd(u.amountCents) }}
              dataAttr="earnings-upcoming-row"
            />
          ))}
        </PortalRecordListSurface>
      ) : null}

      {view === "paid" ? (
        <PortalRecordListSurface isEmpty={data.paid.length === 0} emptyCard={{ title: "No payouts yet" }} dataAttr="earnings-paid">
          {data.paid.map((w) => (
            <PortalEntryRow
              key={w.id}
              tile={{ kind: "glyph", icon: Wallet }}
              title={formatManagedUsd(w.amountCents)}
              facts={[
                { icon: CalendarDays, label: shortDate(w.createdAt), srLabel: "Date" },
                { icon: w.payoutPending ? Clock : CheckCircle2, label: w.payoutPending ? "Bank payout pending" : "Completed", srLabel: "Status" },
              ]}
              dataAttr="earnings-paid-row"
            />
          ))}
        </PortalRecordListSurface>
      ) : null}

      {view === "reports" ? (
        <div className="space-y-4" data-attr="earnings-reports">
          <MonthlyBars months={data.months} />
          <div>
            <StatementBand label="By month" />
            <PortalRecordListSurface dataAttr="earnings-months">
              {[...data.months].reverse().filter((m) => m.grossCents !== 0 || m.netCents !== 0 || m.withdrawnCents !== 0).map((m) => (
                <PortalEntryRow
                  key={m.month}
                  tile={{ kind: "glyph", icon: CalendarDays }}
                  title={managedMonthLabel(m.month)}
                  facts={[
                    { label: `Gross ${formatManagedUsd(m.grossCents)}`, srLabel: "Gross" },
                    ...(m.feeCents !== 0 ? [{ label: `Fee ${formatManagedUsd(m.feeCents)}`, srLabel: "Fee" }] : []),
                    ...(m.otherCents !== 0 ? [{ label: `Splits ${formatManagedUsd(m.otherCents)}`, srLabel: "Splits" }] : []),
                    ...(m.vendorCents !== 0 ? [{ label: `Services ${formatManagedUsd(m.vendorCents)}`, srLabel: "Services" }] : []),
                  ]}
                  figure={{ value: formatManagedUsd(m.netCents), subLabel: "Net" }}
                  dataAttr="earnings-month-row"
                />
              ))}
            </PortalRecordListSurface>
          </div>
          {data.houses.length > 0 ? (
            <div>
              <StatementBand label="By house" count={data.houses.length} />
              <PortalRecordListSurface dataAttr="earnings-houses">
                {data.houses.map((h) => (
                  <PortalEntryRow
                    key={h.propertyId ?? "none"}
                    tile={{ kind: "glyph", icon: Home }}
                    title={h.propertyLabel ?? "House"}
                    figure={{ value: formatManagedUsd(h.cents) }}
                    dataAttr="earnings-house-row"
                  />
                ))}
              </PortalRecordListSurface>
            </div>
          ) : null}
        </div>
      ) : null}

      {view === "methods" ? (
        <PortalRecordListSurface dataAttr="earnings-methods">
          <PortalEntryRow
            tile={{ kind: "glyph", icon: Landmark }}
            title="Payout method"
            facts={[{ icon: data.payoutReady ? CheckCircle2 : Clock, label: data.payoutReady ? "Ready" : data.payoutReady === false ? "Set up needed" : "Unknown", srLabel: "Status" }]}
            onOpen={() => router.push(`${basePath}/payments/payouts`)}
            dataAttr="earnings-method-row"
          />
          <PortalEntryRow
            tile={{ kind: "glyph", icon: Banknote }}
            title="Tax information"
            facts={[{ label: "Held by Stripe", srLabel: "Where" }]}
            onOpen={() => router.push(`${basePath}/payments/payouts`)}
            dataAttr="earnings-tax-row"
          />
        </PortalRecordListSurface>
      ) : null}

      <Modal
        open={withdrawOpen}
        title="Withdraw"
        onClose={() => setWithdrawOpen(false)}
        dataAttr="earnings-withdraw-modal"
        footer={
          <ModalFooter>
            <Button data-attr="earnings-withdraw-submit" onClick={() => withdraw()}>
              Withdraw
            </Button>
          </ModalFooter>
        }
      >
        <div className="flex flex-col gap-3">
          {targets.length > 1 ? (
            <FieldSingleSelect
              label="From"
              options={targets.map((w) => ({ value: w.workspaceId ?? "vendor", label: `${w.workspaceName} · ${formatManagedUsd(w.balance.availableCents)}` }))}
              value={target}
              onChange={(v) => {
                setTarget(v);
                const row = targets.find((w) => (w.workspaceId ?? "vendor") === v);
                setAmount(centsToDollarsInput(row?.balance.availableCents ?? 0));
              }}
              dataAttr="earnings-withdraw-from"
            />
          ) : null}
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Amount</span>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-attr="earnings-withdraw-amount" autoFocus />
          </label>
        </div>
        {error ? (
          <p className="mt-2 text-[13px] text-red-600" role="alert">
            {error}{" "}
            {error.includes("payout setup") ? (
              <Link href={`${basePath}/payments/payouts`} className="font-semibold underline" data-attr="earnings-payouts-setup">
                Set up payouts
              </Link>
            ) : null}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}

