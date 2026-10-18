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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { formatOwnerUsd, ownerMonthLabel, useOwnerFetch } from "@/components/owner/owner-data";
import { OwnerBand, OwnerEmpty, OwnerError, OwnerLoading, OwnerPageTitle, OwnerTile, OwnerTiles } from "@/components/owner/owner-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS, Modal, ModalFooter, PORTAL_MODAL_FORM_FIELD_CLASS } from "@/components/ui/modal";
import { centsToDollarsInput, parseDollarsToCents } from "@/lib/dollar-input";
import { pacificCalendarMonthKey, formatPacificDate } from "@/lib/pacific-time";
import type { OwnerFinancesView } from "@/lib/managed-finance/finances.server";
import { cn } from "@/lib/utils";

type WorkspaceListItem = { id: string; name: string; status: string; feeLine: string };
type WaitingAgreement = { id: string; workspaceId: string; feeLine: string; terms: unknown; effectiveFrom: string };
type WorkspaceList = { workspaces: WorkspaceListItem[]; waiting: WaitingAgreement[] };

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

const KIND_ICON: Record<string, LucideIcon> = {
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

function shortDate(value: string): string {
  return formatPacificDate(value, { month: "short", day: "numeric" });
}

function moneyClass(cents: number): string {
  return cents < 0 ? "text-red-600" : "text-foreground";
}

function AmountFigure({ cents }: { cents: number }) {
  return <span className={cn("min-w-24 shrink-0 text-right text-[14px] font-semibold tabular-nums", moneyClass(cents))}>{formatOwnerUsd(cents)}</span>;
}

function TotalLine({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5 text-sm last:border-b-0", strong && "font-semibold")}>
      <span className="text-foreground">{label}</span>
      <span className={cn("tabular-nums", moneyClass(cents))}>{formatOwnerUsd(cents)}</span>
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

/** `/portal/owner/finances`: balance, statement, repair approvals and withdrawals for the owner of record of a PropLane-managed workspace. */
export function OwnerFinancesPage() {
  const params = useSearchParams();
  const paramWorkspace = params?.get("workspace") ?? "";
  const paramMonth = params?.get("month") ?? "";
  const reviewId = params?.get("review") ?? "";
  const approveId = params?.get("approve") ?? "";

  const list = useOwnerFetch<WorkspaceList>("/api/owner/finances");
  const [picked, setPicked] = useState<string>("");
  const [month, setMonth] = useState<string | null>(MONTH_KEY.test(paramMonth) ? paramMonth : null);
  const [currentMonth] = useState(() => pacificCalendarMonthKey(Date.now()));

  const workspaces = list.data?.workspaces ?? [];
  const waiting = list.data?.waiting ?? [];
  const workspaceId =
    (picked && workspaces.some((w) => w.id === picked) ? picked : "") ||
    (paramWorkspace && workspaces.some((w) => w.id === paramWorkspace) ? paramWorkspace : "") ||
    workspaces[0]?.id ||
    "";

  const viewUrl = workspaceId
    ? `/api/owner/finances?workspace=${encodeURIComponent(workspaceId)}${month ? `&month=${encodeURIComponent(month)}` : ""}`
    : null;
  const viewFetch = useOwnerFetch<OwnerFinancesView>(viewUrl);
  const view = viewFetch.data && viewFetch.data.workspace.id === workspaceId ? viewFetch.data : null;

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reloadAll = () => {
    list.reload();
    viewFetch.reload();
  };

  // Sign an agreement that was sent for signature.
  const sign = async (policyId: string) => {
    setActionError(null);
    const r = await send(`/api/owner/finances/policy/${encodeURIComponent(policyId)}/sign`, "POST");
    if (!r.ok) {
      setActionError(r.error ?? "Could not record your signature.");
      return;
    }
    reloadAll();
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
    setNotice(r.data.payoutPending === true ? "Your bank payout is being set up" : null);
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
  const openedApproveRef = useRef("");
  useEffect(() => {
    if (!approveId || openedApproveRef.current === approveId || !view) return;
    if (view.pendingApprovals.some((p) => p.id === approveId)) {
      openedApproveRef.current = approveId;
      setConfirmId(approveId);
    }
  }, [approveId, view]);
  const reviewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    reviewRef.current?.scrollIntoView?.({ block: "center" });
  }, [reviewId, waiting.length]);
  const confirming = view?.pendingApprovals.find((p) => p.id === confirmId) ?? null;

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

  const noneAtAll = !list.loading && !list.error && list.data !== null && workspaces.length === 0 && waiting.length === 0;

  return (
    <div data-attr="owner-finances">
      <div className="mb-4 flex items-center justify-between gap-2 [&_h1]:mb-0">
        <OwnerPageTitle>Finances</OwnerPageTitle>
        {headerIcons}
      </div>

      {list.loading && !list.data ? (
        <OwnerLoading />
      ) : list.error ? (
        <OwnerError message="Couldn't load your finances." onRetry={list.reload} />
      ) : noneAtAll ? (
        <OwnerEmpty title="No managed workspaces yet" />
      ) : (
        <>
          {waiting.map((w) => (
            <div
              key={w.id}
              ref={reviewId === w.id ? reviewRef : undefined}
              className={cn("mb-4 flex items-center justify-between gap-3 rounded-2xl border bg-card p-4", reviewId === w.id ? "border-primary ring-2 ring-primary/20" : "border-border")}
              data-attr="owner-finances-agreement"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted">Management agreement</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">{w.feeLine}</p>
                <p className="mt-1 inline-flex items-center gap-1 text-[13px] text-muted">
                  <CalendarDays className="size-3.5" aria-hidden /> Starts {shortDate(w.effectiveFrom)}
                </p>
              </div>
              <Button data-attr="owner-finances-sign" onClick={() => sign(w.id)}>
                Sign
              </Button>
            </div>
          ))}

          {workspaces.length > 1 ? (
            <OwnerBand label="">
              <span className="mr-auto flex flex-wrap gap-1" role="tablist" aria-label="Workspaces">
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    role="tab"
                    aria-selected={workspaceId === w.id}
                    data-attr={`owner-finances-workspace-${w.id}`}
                    onClick={() => {
                      setPicked(w.id);
                      setMonth(null);
                    }}
                    className={cn("rounded-md px-2 py-1 text-sm font-semibold", workspaceId === w.id ? "bg-accent text-foreground" : "text-muted")}
                  >
                    {w.name}
                  </button>
                ))}
              </span>
            </OwnerBand>
          ) : null}

          {notice ? (
            <p role="status" className="mb-3 text-sm font-medium text-foreground" data-attr="owner-finances-notice">
              {notice}
            </p>
          ) : null}
          {actionError ? (
            <p role="alert" className="mb-3 text-sm text-red-600">
              {actionError}
            </p>
          ) : null}

          {!workspaceId ? null : viewFetch.error && !view ? (
            <OwnerError message="Couldn't load this workspace's finances." onRetry={viewFetch.reload} />
          ) : !view ? (
            <OwnerLoading />
          ) : (
            <div className={cn(viewFetch.loading && "opacity-60 transition-opacity")}>
              <OwnerTiles>
                <OwnerTile label="Balance" value={formatOwnerUsd(view.balance.balanceCents)} />
                <OwnerTile label="Available to withdraw" value={formatOwnerUsd(view.balance.availableCents)} tone="good" />
                <OwnerTile label="Pending" value={formatOwnerUsd(view.balance.pendingCents)} />
                {view.occupancy ? <OwnerTile label="Rooms occupied" value={`${view.occupancy.occupied} of ${view.occupancy.units}`} /> : null}
              </OwnerTiles>

              <OwnerBand label="Statement">
                <PortalIconAction icon={ChevronLeft} label="Previous month" data-attr="owner-finances-prev-month" onClick={() => setMonth(shiftMonthKey(view.month, -1))} />
                <span className="px-1 text-sm font-semibold tabular-nums text-foreground" data-attr="owner-finances-month">
                  {ownerMonthLabel(view.month)}
                </span>
                <PortalIconAction
                  icon={ChevronRight}
                  label="Next month"
                  data-attr="owner-finances-next-month"
                  disabled={view.month >= currentMonth}
                  onClick={() => setMonth(shiftMonthKey(view.month, 1))}
                />
              </OwnerBand>
              <div className="mb-3 overflow-hidden rounded-2xl border border-border bg-card" data-attr="owner-finances-totals">
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
                  return (
                    <PortalServiceRecordRow
                      key={row.id}
                      title={row.label}
                      subtitle={row.propertyLabel ?? undefined}
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
                          {row.href ? (
                            <PortalIconAction
                              icon={ExternalLink}
                              label="Open"
                              ariaLabel={`Open ${row.label}`}
                              data-attr={`owner-finances-row-open-${row.id}`}
                              onClick={() => window.open(row.href as string, "_blank", "noopener")}
                            />
                          ) : null}
                        </span>
                      }
                      onOpen={() => (row.href ? window.open(row.href, "_blank", "noopener") : undefined)}
                      dataAttr={`owner-finances-row-${row.id}`}
                    />
                  );
                })}
              </PortalRecordListSurface>

              {view.pendingApprovals.length > 0 ? (
                <div className="mt-5" data-attr="owner-finances-approvals">
                  <OwnerBand label="Repair approvals" count={view.pendingApprovals.length}>
                    <PortalIconAction icon={CheckCircle2} label="Approve routine repairs" data-attr="owner-finances-approve-routine" onClick={openRoutine} />
                  </OwnerBand>
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
                        figure={formatOwnerUsd(p.amountCents)}
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
                  <OwnerBand label="Withdrawals" count={view.withdrawals.length} />
                  <PortalRecordListSurface dataAttr="owner-finances-withdrawals-list">
                    {view.withdrawals.map((w) => {
                      const status = withdrawalStatus(w.status);
                      const StatusIcon = status.icon;
                      return (
                        <PortalServiceRecordRow
                          key={w.id}
                          title={formatOwnerUsd(w.amountCents)}
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
        onClose={() => setConfirmId(null)}
        dataAttr="owner-finances-confirm-modal"
        footer={
          confirming ? (
            <ModalFooter>
              <Button
                variant="danger"
                data-attr="owner-finances-confirm-decline"
                onClick={async () => {
                  if (await decide(confirming.id, false)) setConfirmId(null);
                }}
              >
                Decline
              </Button>
              <Button
                data-attr="owner-finances-confirm-approve"
                onClick={async () => {
                  if (await decide(confirming.id, true)) setConfirmId(null);
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
            <span className="font-semibold tabular-nums text-foreground">{formatOwnerUsd(confirming.amountCents)}</span>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
