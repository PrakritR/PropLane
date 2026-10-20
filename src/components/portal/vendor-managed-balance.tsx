"use client";

/**
 * Vendor Finances, "PropLane balance" (owner-management, § Vendors).
 *
 * What PropLane owes this vendor for jobs on PropLane-managed workspaces: tiles (Balance · Available · Pending), a month
 * selector, the month's statement, the withdrawals so far, and a Withdraw pop-up. Every figure comes from
 * `GET /api/vendor/managed-finance` (the party ledger); nothing is computed here, and an amount the vendor types is only
 * parsed to integer cents. A vendor with no managed activity (everything zero and empty), or a read that fails, renders
 * nothing at all, so a self-serve vendor sees exactly what they saw before.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpFromLine, Calendar, ChevronLeft, ChevronRight, Landmark } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalRowFact, PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PortalStatStrip } from "@/components/portal/portal-stat-strip";
import { formatMoney } from "@/components/portal/portal-payouts-panel";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Input } from "@/components/ui/input";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { formatPortalMonth } from "@/lib/portal-display-dates";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";
import { track } from "@/lib/analytics/track-client";
import type { VendorFinancesView } from "@/lib/managed-finance/finances.server";

const API = "/api/vendor/managed-finance";

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** The shape guard for the read: anything else is treated as "nothing here". */
function isVendorFinancesView(v: unknown): v is VendorFinancesView {
  const view = v as Partial<VendorFinancesView> | null;
  return Boolean(
    view &&
      typeof view.month === "string" &&
      view.balance &&
      isInt(view.balance.balanceCents) &&
      isInt(view.balance.availableCents) &&
      isInt(view.balance.pendingCents) &&
      view.statement &&
      Array.isArray(view.statement.rows) &&
      Array.isArray(view.withdrawals),
  );
}

/** True when the vendor has never had anything on a PropLane-managed workspace. */
export function isVendorManagedEmpty(view: VendorFinancesView): boolean {
  return (
    view.balance.balanceCents === 0 &&
    view.balance.availableCents === 0 &&
    view.balance.pendingCents === 0 &&
    (view.balance.reserveCents ?? 0) === 0 &&
    view.statement.rows.length === 0 &&
    view.withdrawals.length === 0
  );
}

/** "12.5" / "$1,200.00" -> integer cents. Digits only, at most two decimals; anything else is NaN. */
export function parseAmountToCents(raw: string): number {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shortDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusWord(status: string): string {
  const word = status.replaceAll("_", " ");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

type WithdrawFailure = { message: string; code?: string };

export function VendorManagedBalance({ basePath = "/vendor" }: { basePath?: string }) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [view, setView] = useState<VendorFinancesView | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState<string | null>(null);
  const [monthError, setMonthError] = useState(false);
  const [shown, setShown] = useState(false);
  const sequence = useRef(0);

  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [failure, setFailure] = useState<WithdrawFailure | null>(null);
  const clientKey = useRef("");

  const load = useCallback(async (target: string | null) => {
    const run = ++sequence.current;
    const url = target ? `${API}?month=${encodeURIComponent(target)}` : API;
    let read: Awaited<ReturnType<typeof sharedGet>>;
    try {
      read = await sharedGet(url, { ttlMs: 0 });
    } catch {
      return;
    }
    if (run !== sequence.current) return;
    if (!read.ok || !isVendorFinancesView(read.data)) {
      // A failed first read hides the card; a failed month change keeps the controls and says so in the list.
      setMonthError(true);
      return;
    }
    const next = read.data;
    setMonthError(false);
    setView(next);
    setMonth(next.month);
    if (!target) setCurrentMonth(next.month);
    if (!isVendorManagedEmpty(next)) setShown(true);
  }, []);

  useEffect(() => {
    void load(null);
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  if (!view || !shown) return null;

  const { balance, statement, withdrawals } = view;
  const available = balance.availableCents;
  const amountCents = parseAmountToCents(amount);
  const canSubmit = Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= available;
  const shownMonth = month ?? view.month;

  function openWithdraw() {
    clientKey.current = crypto.randomUUID();
    setAmount(centsToInput(available));
    setFailure(null);
    setWithdrawOpen(true);
    track("managed_balance_withdraw_started", { portal: "vendor" });
  }

  async function submitWithdraw() {
    if (!canSubmit) return;
    setFailure(null);
    try {
      const res = await fetch(`${API}/withdraw`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents, clientKey: clientKey.current }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; payoutPending?: boolean; payoutAutomatic?: boolean; payoutScheduleUnknown?: boolean };
      if (!res.ok) {
        setFailure({ message: body.error ?? "Could not withdraw.", code: body.code });
        return;
      }
      track("managed_balance_withdraw_submitted", { portal: "vendor", amount_cents: amountCents });
      showToast(
        body.payoutScheduleUnknown
          ? "Withdrawal sent. We could not check your payout schedule, so we will finish the bank payout and follow up."
          : body.payoutAutomatic
            ? "Withdrawal sent. It is on its way with your next automatic payout."
            : body.payoutPending
              ? "Withdrawal sent. Your bank payout is being set up."
              : "Withdrawal submitted.",
      );
      setWithdrawOpen(false);
      invalidateSharedGets(API);
      await load(month);
    } catch {
      setFailure({ message: "Could not withdraw." });
    }
  }

  return (
    <section className="mb-4 space-y-3" data-attr="vendor-managed-balance">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">PropLane balance</h2>
        <PortalIconAction
          icon={ArrowUpFromLine}
          label="Withdraw"
          disabled={available <= 0}
          data-attr="vendor-managed-withdraw"
          onClick={openWithdraw}
        />
      </div>

      <PortalStatStrip
        dataAttr="vendor-managed-stats"
        items={[
          { id: "balance", label: "Balance", value: formatMoney(balance.balanceCents, "usd"), dataAttr: "vendor-managed-balance-total" },
          { id: "available", label: "Available to withdraw", value: formatMoney(available, "usd"), dataAttr: "vendor-managed-balance-available" },
          { id: "pending", label: "Pending", value: formatMoney(balance.pendingCents, "usd"), dataAttr: "vendor-managed-balance-pending" },
        ]}
      />

      <div className="flex items-center gap-1" data-attr="vendor-managed-month">
        <PortalIconAction
          icon={ChevronLeft}
          label="Previous month"
          data-attr="vendor-managed-month-prev"
          onClick={() => void load(shiftMonth(shownMonth, -1))}
        />
        <span className="min-w-[5.5rem] text-center text-sm font-medium text-foreground" data-attr="vendor-managed-month-label">
          {formatPortalMonth(shownMonth)}
        </span>
        <PortalIconAction
          icon={ChevronRight}
          label="Next month"
          disabled={!currentMonth || shownMonth >= currentMonth}
          data-attr="vendor-managed-month-next"
          onClick={() => void load(shiftMonth(shownMonth, 1))}
        />
      </div>

      {monthError ? (
        <p role="alert" className="text-sm text-danger" data-attr="vendor-managed-month-error">
          Could not load this month.
        </p>
      ) : (
        <PortalRecordListSurface
          dataAttr="vendor-managed-statement"
          isEmpty={statement.rows.length === 0}
          emptyCard={{ title: "No activity this month", section: "financials", tone: "muted" }}
        >
          {statement.rows.map((row) => {
            const date = shortDate(row.date);
            return (
              <PortalServiceRecordRow
                key={row.id}
                title={row.label}
                facts={date ? <PortalRowFact icon={Calendar} srLabel="Date">{date}</PortalRowFact> : undefined}
                figure={formatMoney(row.amountCents, "usd")}
                figureTone={row.amountCents < 0 ? "danger" : undefined}
                onOpen={() => {
                  if (row.href) navigate(row.href);
                }}
                dataAttr="vendor-managed-statement-row"
              />
            );
          })}
        </PortalRecordListSurface>
      )}

      {withdrawals.length > 0 ? (
        <div className="space-y-2" data-attr="vendor-managed-withdrawals">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Withdrawals</h3>
          <PortalRecordListSurface dataAttr="vendor-managed-withdrawals-list">
            {withdrawals.map((w) => {
              const date = shortDate(w.createdAt);
              return (
                <PortalServiceRecordRow
                  key={w.id}
                  title="Withdrawal"
                  facts={
                    <>
                      {date ? <PortalRowFact icon={Calendar} srLabel="Date">{date}</PortalRowFact> : null}
                      <PortalRowFact icon={Landmark} srLabel="Status">
                        {w.payoutPending ? "Bank payout is being set up" : statusWord(w.status)}
                      </PortalRowFact>
                    </>
                  }
                  figure={formatMoney(w.amountCents, "usd")}
                  onOpen={() => {}}
                  dataAttr="vendor-managed-withdrawal-row"
                />
              );
            })}
          </PortalRecordListSurface>
        </div>
      ) : null}

      <PortalDialog
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        title="Withdraw from PropLane balance"
        dataAttr="vendor-managed-withdraw-dialog"
        primaryAction={{
          label: canSubmit ? `Withdraw ${formatMoney(amountCents, "usd")}` : "Withdraw",
          onClick: () => submitWithdraw(),
          disabled: !canSubmit,
          dataAttr: "vendor-managed-withdraw-confirm",
        }}
      >
        <div className="space-y-4 p-1">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted">Amount</span>
            <Input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              aria-label="Amount"
              data-attr="vendor-managed-withdraw-amount"
            />
          </label>
          {failure ? (
            <div role="alert" className="space-y-1 text-sm text-danger" data-attr="vendor-managed-withdraw-error">
              <p>{failure.message}</p>
              {failure.code === "PAYOUTS_NOT_READY" ? (
                <Link
                  href={`${basePath}/profile?tab=payouts`}
                  className="font-medium text-primary underline"
                  data-attr="vendor-managed-withdraw-setup"
                >
                  Set up payouts
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      </PortalDialog>
    </section>
  );
}
