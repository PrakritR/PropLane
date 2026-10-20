"use client";

import {
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  ListChecks,
  Percent,
  Receipt,
  Settings,
  Undo2,
  Wallet,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PortalStatStrip } from "@/components/portal/portal-stat-strip";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS, Modal, ModalFooter, PORTAL_MODAL_FORM_FIELD_CLASS } from "@/components/ui/modal";
import { centsToDollarsInput, parseDollarsToCents } from "@/lib/dollar-input";
import { pacificCalendarMonthKey, formatPacificDate } from "@/lib/pacific-time";
import type { OwnerFinancesView } from "@/lib/managed-finance/finances.server";
import { formatManagedUsd, managedMonthLabel } from "@/lib/managed-finance/format";
import { feePercentForOwnerShareBps } from "@/lib/owner-management/fee-percent";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";
import { cn } from "@/lib/utils";

export const OWNER_PAYOUTS_LIST_URL = "/api/owner/finances";

/** A statement line about a service opens that house in the Property portal. */
function propertyHref(propertyId: string | null | undefined): string | null {
  const id = (propertyId ?? "").trim();
  return id ? `/portal/properties/all/${encodeURIComponent(id)}` : null;
}

type FetchState<T> = { data: T | null; loading: boolean; error: string | null; reload: () => void };

/** One GET through the shared cache: loading and error are first-class; a refusal (403) is an error, never a crash. */
function useJsonFetch<T>(url: string | null): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    void sharedGet(url, { force: tick > 0 }).then((res) => {
      if (!live) return;
      if (res.ok) setData(res.data as T);
      else setError((res.data as { error?: string } | null)?.error ?? "Request failed.");
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [url, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, loading, error, reload };
}

/**
 * Whether the signed-in account may open Owner payouts: the owner of record of a PropLane-managed workspace. The server answers 403 for everyone else, so the tab simply never shows.
 */
export function useOwnerPayoutsAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    void sharedGet(OWNER_PAYOUTS_LIST_URL).then((res) => {
      if (live) setAllowed(res.ok);
    });
    return () => {
      live = false;
    };
  }, []);
  return allowed;
}

/** The label row above a block of rows: the name and a plain count on the left, icon chrome on the right. */
function StatementBand({ children, label, count }: { children?: ReactNode; label: string; count?: number }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2 px-1">
      <span className="text-[13px] font-semibold text-foreground">
        {label}
        {count !== undefined ? <span className="ml-1.5 font-medium tabular-nums text-muted">{count}</span> : null}
      </span>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

type WorkspaceListItem = { id: string; name: string; status: string; feeLine: string };
type WorkspaceList = { workspaces: WorkspaceListItem[] };

type SendResult = { ok: boolean; error?: string; code?: string; data: Record<string, unknown> };

/** One owner write. Never throws: the caller shows `error` as the server worded it. */
async function send(url: string, method: "POST" | "PATCH", body?: unknown): Promise<SendResult> {
  try {
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === "string" ? data.error : "That didn't go through. Try again.",
        code: typeof data.code === "string" ? data.code : undefined,
        data,
      };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "That didn't go through. Try again.", data: {} };
  }
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-10" shifted by `delta` months. Pure calendar arithmetic on the key. */
export function shiftMonthKey(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export const KIND_ICON: Record<string, LucideIcon> = {
  rent: Banknote,
  fee: Percent,
  fee_returned: Percent,
  refund: Undo2,
  vendor_charge: Wrench,
  withdrawal: Wallet,
  withdrawal_returned: Wallet,
};

const WITHDRAWAL_STATUS: Record<string, { label: string; icon: LucideIcon }> = {
  completed: { label: "Completed", icon: CheckCircle2 },
  pending: { label: "Pending", icon: Clock },
  processing: { label: "Processing", icon: Clock },
  failed: { label: "Failed", icon: XCircle },
  returned: { label: "Returned", icon: XCircle },
};

function withdrawalStatus(status: string) {
  return WITHDRAWAL_STATUS[status] ?? { label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " "), icon: Clock };
}

export function shortDate(value: string): string {
  return formatPacificDate(value, { month: "short", day: "numeric" });
}

function moneyClass(cents: number): string {
  return cents < 0 ? "text-red-600" : "text-foreground";
}

export function AmountFigure({ cents }: { cents: number }) {
  return <span className={cn("min-w-24 shrink-0 text-right text-[14px] font-semibold tabular-nums", moneyClass(cents))}>{formatManagedUsd(cents)}</span>;
}

export function TotalLine({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5 text-sm last:border-b-0", strong && "font-semibold")}>
      <span className="text-foreground">{label}</span>
      <span className={cn("tabular-nums", moneyClass(cents))}>{formatManagedUsd(cents)}</span>
    </div>
  );
}

function DollarField({ label, value, onChange, dataAttr, autoFocus }: { label: string; value: string; onChange: (next: string) => void; dataAttr: string; autoFocus?: boolean }) {
  return (
    <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
      <span className={MODAL_FIELD_LABEL_CLASS}>{label}</span>
      <Input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" data-attr={dataAttr} autoFocus={autoFocus} />
    </label>
  );
}

function ModalError({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 text-[13px] text-red-600" role="alert">
      {children}
    </p>
  );
}

/** Finances › Owner payouts: balance, statement, repair approvals and withdrawals for the owner of record of a PropLane-managed workspace. */
export function OwnerPayoutsPanel() {
  const params = useSearchParams();
  const paramWorkspace = params?.get("workspace") ?? "";
  const paramMonth = params?.get("month") ?? "";
  const approveId = params?.get("approve") ?? "";

  const workspaceContext = useWorkspaces();
  const list = useJsonFetch<WorkspaceList>(OWNER_PAYOUTS_LIST_URL);
  const [month, setMonth] = useState<string | null>(MONTH_KEY.test(paramMonth) ? paramMonth : null);
  const [currentMonth] = useState(() => pacificCalendarMonthKey(Date.now()));

  const workspaces = list.data?.workspaces ?? [];
  // A link that names a workspace wins, then the workspace the switcher is on (when PropLane holds its funds), then the first one
  // that is held: Finances never dead-ends on a workspace with nothing to show.
  const workspaceId =
    (paramWorkspace && workspaces.some((w) => w.id === paramWorkspace) ? paramWorkspace : "") ||
    (workspaceContext?.active?.id && workspaces.some((w) => w.id === workspaceContext.active?.id) ? workspaceContext.active.id : "") ||
    workspaces[0]?.id ||
    "";

  const viewUrl = workspaceId
    ? `/api/owner/finances?workspace=${encodeURIComponent(workspaceId)}${month ? `&month=${encodeURIComponent(month)}` : ""}`
    : null;
  const viewFetch = useJsonFetch<OwnerFinancesView>(viewUrl);
  const view = viewFetch.data && viewFetch.data.workspace.id === workspaceId ? viewFetch.data : null;

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reloadAll = () => {
    invalidateSharedGets(OWNER_PAYOUTS_LIST_URL);
    list.reload();
    viewFetch.reload();
  };

  // Withdraw.
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawError, setWithdrawError] = useState<{ message: string; code?: string } | null>(null);
  const clientKeyRef = useRef("");
  const openWithdraw = () => {
    clientKeyRef.current = crypto.randomUUID();
    setWithdrawAmount(centsToDollarsInput(view?.balance.availableCents ?? 0));
    setWithdrawError(null);
    setWithdrawOpen(true);
  };
  const withdraw = async () => {
    const amountCents = parseDollarsToCents(withdrawAmount);
    if (amountCents === null) {
      setWithdrawError({ message: "Enter an amount, like 250.00." });
      return;
    }
    setWithdrawError(null);
    const r = await send("/api/owner/finances/withdraw", "POST", { workspaceId, amountCents, clientKey: clientKeyRef.current });
    if (!r.ok) {
      setWithdrawError({ message: r.error ?? "Could not start the withdrawal.", code: r.code });
      return;
    }
    setWithdrawOpen(false);
    setNotice(
      r.data.payoutScheduleUnknown === true
        ? "We could not check your payout schedule — we will finish the bank payout and follow up"
        : r.data.payoutAutomatic === true
          ? "On its way with your next automatic payout"
          : r.data.payoutPending === true
            ? "Your bank payout is being set up"
            : null,
    );
    reloadAll();
  };

  // Settings.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [thresholdText, setThresholdText] = useState("");
  const [reserveText, setReserveText] = useState("");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const openSettings = () => {
    setThresholdText(centsToDollarsInput(view?.policy.terms.repairApprovalThresholdCents ?? 0));
    setReserveText(centsToDollarsInput(view?.policy.terms.reserveTargetCents ?? 0));
    setSettingsError(null);
    setSettingsOpen(true);
  };
  const saveSettings = async () => {
    if (!view) return;
    const repairApprovalThresholdCents = parseDollarsToCents(thresholdText, true);
    const reserveTargetCents = parseDollarsToCents(reserveText, true);
    if (repairApprovalThresholdCents === null || reserveTargetCents === null) {
      setSettingsError("Enter amounts like 250.00, or 0 for none.");
      return;
    }
    setSettingsError(null);
    const r = await send(`/api/owner/finances/policy/${encodeURIComponent(view.policy.id)}`, "PATCH", { repairApprovalThresholdCents, reserveTargetCents });
    if (!r.ok) {
      setSettingsError(r.error ?? "Could not save.");
      return;
    }
    setSettingsOpen(false);
    viewFetch.reload();
  };

  // Repair approvals.
  const decide = async (expenseId: string, approve: boolean) => {
    setActionError(null);
    const r = await send(`/api/owner/finances/expenses/${encodeURIComponent(expenseId)}`, "POST", { approve });
    if (!r.ok) {
      setActionError(r.error ?? "Could not record your answer.");
      return false;
    }
    viewFetch.reload();
    return true;
  };
  const [routineOpen, setRoutineOpen] = useState(false);
  const [routineCap, setRoutineCap] = useState("");
  const [routineError, setRoutineError] = useState<string | null>(null);
  const openRoutine = () => {
    const threshold = view?.policy.terms.repairApprovalThresholdCents ?? 0;
    setRoutineCap(threshold > 0 ? centsToDollarsInput(threshold) : "");
    setRoutineError(null);
    setRoutineOpen(true);
  };
  const approveRoutine = async () => {
    const capCents = parseDollarsToCents(routineCap);
    if (capCents === null) {
      setRoutineError("Enter an amount, like 250.00.");
      return;
    }
    setRoutineError(null);
    const r = await send("/api/owner/finances/expenses/approve-routine", "POST", { workspaceId, capCents });
    if (!r.ok) {
      setRoutineError(r.error ?? "Could not save.");
      return;
    }
    setRoutineOpen(false);
    viewFetch.reload();
  };

  // A link from a text or email: `?approve=<expense>` opens that one repair to confirm; `?review=<agreement>` marks the agreement.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [dismissedApprove, setDismissedApprove] = useState("");
  const linkedApprove = approveId && approveId !== dismissedApprove && view?.pendingApprovals.some((p) => p.id === approveId) ? approveId : null;
  const confirmTarget = confirmId ?? linkedApprove;
  const closeConfirm = () => {
    setConfirmId(null);
    setDismissedApprove(approveId);
  };
  const confirming = view?.pendingApprovals.find((p) => p.id === confirmTarget) ?? null;

  const downloadStatement = () => {
    if (!view) return;
    window.location.assign(`/api/owner/finances/statement?workspace=${encodeURIComponent(workspaceId)}&month=${encodeURIComponent(view.month)}`);
  };

  const headerIcons = view ? (
    <div className="flex items-center gap-0.5">
      <PortalIconAction icon={Wallet} label="Withdraw" data-attr="owner-finances-withdraw" onClick={openWithdraw} />
      <PortalIconAction icon={Download} label="Download statement" data-attr="owner-finances-download" onClick={downloadStatement} />
      <PortalIconAction icon={Settings} label="Settings" data-attr="owner-finances-settings" onClick={openSettings} />
    </div>
  ) : null;

  const noneAtAll = !list.loading && !list.error && list.data !== null && workspaces.length === 0;

  return (
    <div data-attr="owner-finances" className="min-w-0 space-y-4 max-lg:space-y-3">
      {headerIcons ? <div className="flex items-center justify-end gap-2">{headerIcons}</div> : null}

      {list.loading && !list.data ? (
        <PortalRecordListSurface loading dataAttr="owner-finances-loading" />
      ) : list.error ? (
        <PortalRecordListSurface loadError="Couldn't load your finances." onRetry={list.reload} dataAttr="owner-finances-error" />
      ) : noneAtAll ? (
        <PortalRecordListSurface isEmpty emptyCard={{ title: "No managed workspaces yet" }} dataAttr="owner-finances-empty" />
      ) : (
        <>
          {notice ? (
            <p role="status" className="text-sm font-medium text-foreground" data-attr="owner-finances-notice">
              {notice}
            </p>
          ) : null}
          {actionError ? (
            <p role="alert" className="text-sm text-red-600">
              {actionError}
            </p>
          ) : null}

          {!workspaceId ? null : viewFetch.error && !view ? (
            <PortalRecordListSurface loadError="Couldn't load this workspace's finances." onRetry={viewFetch.reload} dataAttr="owner-finances-view-error" />
          ) : !view ? (
            <PortalRecordListSurface loading dataAttr="owner-finances-view-loading" />
          ) : (
            <div className={cn(viewFetch.loading && "opacity-60 transition-opacity")}>
              <PortalStatStrip
                size="lg"
                dataAttr="owner-finances-balance-strip"
                className="mb-4"
                items={[
                  { id: "balance", label: "Balance", value: formatManagedUsd(view.balance.balanceCents), dataAttr: "owner-finances-balance" },
                  { id: "available", label: "Available to withdraw", value: formatManagedUsd(view.balance.availableCents), tone: "ok", dataAttr: "owner-finances-available" },
                  { id: "pending", label: "Pending", value: formatManagedUsd(view.balance.pendingCents), dataAttr: "owner-finances-pending" },
                  { id: "fee", label: "Management fee", value: `${feePercentForOwnerShareBps(view.policy.terms.ownerShareBps)}%`, dataAttr: "owner-finances-fee" },
                  ...(view.scheduledFee
                    ? [{
                        id: "fee-next",
                        label: `Management fee from ${shortDate(view.scheduledFee.effectiveFrom)}`,
                        value: `${view.scheduledFee.feePercent}%`,
                        dataAttr: "owner-finances-fee-scheduled",
                      }]
                    : []),
                  ...(view.occupancy ? [{ id: "rooms", label: "Rooms occupied", value: `${view.occupancy.occupied} of ${view.occupancy.units}` }] : []),
                ]}
              />

              <StatementBand label="Statement">
                <PortalIconAction icon={ChevronLeft} label="Previous month" data-attr="owner-finances-prev-month" onClick={() => setMonth(shiftMonthKey(view.month, -1))} />
                <span className="px-1 text-sm font-semibold tabular-nums text-foreground" data-attr="owner-finances-month">
                  {managedMonthLabel(view.month)}
                </span>
                <PortalIconAction
                  icon={ChevronRight}
                  label="Next month"
                  data-attr="owner-finances-next-month"
                  disabled={view.month >= currentMonth}
                  onClick={() => setMonth(shiftMonthKey(view.month, 1))}
                />
              </StatementBand>
              <div className="mb-3 overflow-hidden rounded-xl border border-border bg-card" data-attr="owner-finances-totals">
                <TotalLine label="Rent collected" cents={view.statement.totals.rentGrossCents} />
                <TotalLine label="PropLane fee" cents={view.statement.totals.feeCents} />
                <TotalLine label="Repairs and vendors" cents={view.statement.totals.vendorChargesCents} />
                {view.statement.totals.otherCents !== 0 ? <TotalLine label="Adjustments" cents={view.statement.totals.otherCents} /> : null}
                <TotalLine label="Net to you" cents={view.statement.totals.netCents} strong />
                <TotalLine label="Withdrawals" cents={view.statement.totals.withdrawalsCents} />
                <TotalLine label="Balance at the end of the month" cents={view.statement.endingCents} strong />
              </div>
              <PortalRecordListSurface dataAttr="owner-finances-statement">
                <PortalServiceRecordRow
                  title="Beginning balance"
                  useServiceTile={false}
                  leading={
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
                      <Wallet className="size-5" />
                    </span>
                  }
                  actions={<AmountFigure cents={view.statement.beginningCents} />}
                  onOpen={() => undefined}
                  dataAttr="owner-finances-row-beginning"
                />
                {view.statement.rows.map((row) => {
                  const Icon = KIND_ICON[row.kind] ?? Receipt;
                  const href = row.kind === "vendor_charge" ? propertyHref(row.propertyId) : null;
                  return (
                    <PortalServiceRecordRow
                      key={row.id}
                      title={row.label}
                      subtitle={(row as { propertyLabel?: string | null }).propertyLabel ?? undefined}
                      useServiceTile={false}
                      leading={
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
                          <Icon className="size-5" />
                        </span>
                      }
                      facts={
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="size-3.5" aria-hidden /> {shortDate(row.date)}
                        </span>
                      }
                      actions={
                        <span className="flex items-center gap-1">
                          <AmountFigure cents={row.amountCents} />
                          {href ? (
                            <PortalIconAction
                              icon={ExternalLink}
                              label="Open"
                              ariaLabel={`Open ${row.label}`}
                              data-attr={`owner-finances-row-open-${row.id}`}
                              onClick={() => window.location.assign(href)}
                            />
                          ) : null}
                        </span>
                      }
                      onOpen={() => (href ? window.location.assign(href) : undefined)}
                      dataAttr={`owner-finances-row-${row.id}`}
                    />
                  );
                })}
              </PortalRecordListSurface>

              {view.pendingApprovals.length > 0 ? (
                <div className="mt-5" data-attr="owner-finances-approvals">
                  <StatementBand label="Repair approvals" count={view.pendingApprovals.length}>
                    <PortalIconAction icon={ListChecks} label="Approve routine repairs" data-attr="owner-finances-approve-routine" onClick={openRoutine} />
                  </StatementBand>
                  <PortalRecordListSurface dataAttr="owner-finances-approvals-list">
                    {view.pendingApprovals.map((p) => (
                      <PortalServiceRecordRow
                        key={p.id}
                        title={p.title}
                        subtitle={p.vendorLabel || undefined}
                        facts={
                          <span className="inline-flex items-center gap-1">
                            <CalendarDays className="size-3.5" aria-hidden /> {shortDate(p.requestedAt)}
                          </span>
                        }
                        figure={formatManagedUsd(p.amountCents)}
                        actions={
                          <span className="flex items-center">
                            <PortalIconAction icon={CheckCircle2} tone="primary" label="Approve" ariaLabel={`Approve ${p.title}`} data-attr={`owner-finances-approve-${p.id}`} onClick={() => decide(p.id, true)} />
                            <PortalIconAction icon={XCircle} tone="danger" label="Decline" ariaLabel={`Decline ${p.title}`} data-attr={`owner-finances-decline-${p.id}`} onClick={() => decide(p.id, false)} />
                          </span>
                        }
                        onOpen={() => setConfirmId(p.id)}
                        dataAttr={`owner-finances-approval-${p.id}`}
                      />
                    ))}
                  </PortalRecordListSurface>
                </div>
              ) : null}

              {view.withdrawals.length > 0 ? (
                <div className="mt-5" data-attr="owner-finances-withdrawals">
                  <StatementBand label="Withdrawals" count={view.withdrawals.length} />
                  <PortalRecordListSurface dataAttr="owner-finances-withdrawals-list">
                    {view.withdrawals.map((w) => {
                      const status = withdrawalStatus(w.status);
                      const StatusIcon = status.icon;
                      return (
                        <PortalServiceRecordRow
                          key={w.id}
                          title={formatManagedUsd(w.amountCents)}
                          useServiceTile={false}
                          leading={
                            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
                              <Wallet className="size-5" />
                            </span>
                          }
                          facts={
                            <>
                              <span className="inline-flex items-center gap-1">
                                <CalendarDays className="size-3.5" aria-hidden /> {shortDate(w.createdAt)}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <StatusIcon className="size-3.5" aria-hidden /> {status.label}
                              </span>
                            </>
                          }
                          onOpen={() => undefined}
                          dataAttr={`owner-finances-withdrawal-${w.id}`}
                        />
                      );
                    })}
                  </PortalRecordListSurface>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}

      <Modal
        open={withdrawOpen}
        title="Withdraw"
        onClose={() => setWithdrawOpen(false)}
        dataAttr="owner-finances-withdraw-modal"
        footer={
          <ModalFooter>
            <Button data-attr="owner-finances-withdraw-submit" onClick={() => withdraw()}>
              Withdraw
            </Button>
          </ModalFooter>
        }
      >
        <DollarField label="Amount" value={withdrawAmount} onChange={setWithdrawAmount} dataAttr="owner-finances-withdraw-amount" autoFocus />
        {withdrawError ? (
          <ModalError>
            {withdrawError.message}
            {withdrawError.code === "PAYOUTS_NOT_READY" ? (
              <>
                {" "}
                <Link href="/portal/payments/payouts" className="font-semibold underline" data-attr="owner-finances-payouts-setup">
                  Set up payouts
                </Link>
              </>
            ) : null}
          </ModalError>
        ) : null}
      </Modal>

      <Modal
        open={settingsOpen}
        title="Settings"
        onClose={() => setSettingsOpen(false)}
        dataAttr="owner-finances-settings-modal"
        footer={
          <ModalFooter>
            <Button data-attr="owner-finances-settings-save" onClick={() => saveSettings()}>
              Save
            </Button>
          </ModalFooter>
        }
      >
        <div className="flex flex-col gap-3">
          <DollarField label="Approve repairs automatically up to" value={thresholdText} onChange={setThresholdText} dataAttr="owner-finances-threshold" />
          <DollarField label="Keep in your account" value={reserveText} onChange={setReserveText} dataAttr="owner-finances-reserve" />
        </div>
        {settingsError ? <ModalError>{settingsError}</ModalError> : null}
      </Modal>

      <Modal
        open={routineOpen}
        title="Approve routine repairs"
        onClose={() => setRoutineOpen(false)}
        dataAttr="owner-finances-routine-modal"
        footer={
          <ModalFooter>
            <Button data-attr="owner-finances-routine-submit" onClick={() => approveRoutine()}>
              Approve
            </Button>
          </ModalFooter>
        }
      >
        <DollarField label="Repairs up to" value={routineCap} onChange={setRoutineCap} dataAttr="owner-finances-routine-cap" autoFocus />
        {routineError ? <ModalError>{routineError}</ModalError> : null}
      </Modal>

      <Modal
        open={confirming !== null}
        title={confirming ? confirming.title : "Repair"}
        onClose={closeConfirm}
        dataAttr="owner-finances-confirm-modal"
        footer={
          confirming ? (
            <ModalFooter>
              <Button
                variant="danger"
                data-attr="owner-finances-confirm-decline"
                onClick={async () => {
                  if (await decide(confirming.id, false)) closeConfirm();
                }}
              >
                Decline
              </Button>
              <Button
                data-attr="owner-finances-confirm-approve"
                onClick={async () => {
                  if (await decide(confirming.id, true)) closeConfirm();
                }}
              >
                Approve
              </Button>
            </ModalFooter>
          ) : null
        }
      >
        {confirming ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-foreground">{confirming.vendorLabel}</span>
            <span className="font-semibold tabular-nums text-foreground">{formatManagedUsd(confirming.amountCents)}</span>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
