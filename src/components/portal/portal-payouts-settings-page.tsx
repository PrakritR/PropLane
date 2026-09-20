"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, CreditCard, Landmark, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import {
  bankToWithdrawAccounts,
  formatDate,
  formatMoney,
  HistorySection,
  ScheduleCard,
  type PortalPayoutBalance,
  type PortalPayoutsPortalKind,
} from "@/components/portal/portal-payouts-panel";
import { PayoutWithdrawSheet, type PayoutWithdrawAccount } from "@/components/portal/payout-withdraw-sheet";
import { StripeConnectEmbedded } from "@/components/stripe-connect-embedded";
import { track } from "@/lib/analytics/track-client";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { cn } from "@/lib/utils";

const PORTAL_API_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe",
  vendor: "/api/vendor",
};

const PORTAL_CONNECT_BASE: Record<PortalPayoutsPortalKind, string> = {
  manager: "/api/stripe/connect",
  vendor: "/api/vendor/stripe-connect",
};

type BankAccountRow = {
  id: string;
  kind: "bank" | "card";
  label: string;
  last4: string;
  status: "verified" | "verifying";
  default: boolean;
};

type SheetRenderProps = { open: boolean; onClose: () => void };

function StepRow({ index, done, label, action }: { index: number; done: boolean; label: string; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold",
            done ? "bg-primary text-white" : "bg-accent text-muted",
          )}
        >
          {done ? <Check className="size-3.5" strokeWidth={3} /> : index}
        </span>
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
      </div>
      {action}
    </div>
  );
}

/** A per-row ⋯ that owns its own scope — mirrors `PayoutRowMenu` in `portal-payouts-panel.tsx`. */
function BankRowMenu({ rowId, label, children }: { rowId: string; label: string; children: ReactNode }) {
  return (
    <RecordActionContext.Provider value={{ scope: rowId, clear: () => {}, actions: children }}>
      <RecordActionMenu label={label} activate={() => {}} />
    </RecordActionContext.Provider>
  );
}

/**
 * Settings → Payouts (manager `/portal/settings/payouts`, vendor twin under
 * `Vendor → Settings → Payouts`) — one page: Balance with the Withdraw
 * action, Set up (until ready), Bank accounts (Airbnb "How you get paid"
 * shape), Schedule, and History (PLAN-0920-1500 screen 1).
 *
 * `renderVerifySheet` / `renderBankSheet` are the seam another worker's
 * in-house identity/bank forms mount behind — until those land, Verify and
 * Add a bank account both fall back to the same Stripe embedded onboarding
 * modal `PortalPayoutSetupCard` already uses today, so neither step is ever
 * dead. `/onboard`'s hosted redirect is never used here.
 */
export function PortalPayoutsSettingsPage({
  portal,
  renderVerifySheet,
  renderBankSheet,
}: {
  portal: PortalPayoutsPortalKind;
  renderVerifySheet?: (props: SheetRenderProps) => ReactNode;
  renderBankSheet?: (props: SheetRenderProps) => ReactNode;
}) {
  const { showToast } = useAppUi();
  const apiBase = PORTAL_API_BASE[portal];
  const connectBase = PORTAL_CONNECT_BASE[portal];

  const [balance, setBalance] = useState<PortalPayoutBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  // Independent per-sheet open state — Verify and Add a bank account must
  // never share one flag, or opening one (fallback or custom) also pops the
  // other's fallback modal open behind it.
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [bankSheetOpen, setBankSheetOpen] = useState(false);

  const [bankRows, setBankRows] = useState<BankAccountRow[] | null>(null);
  const [bankRoute, setBankRoute] = useState<"live" | "fallback" | "loading">("loading");

  const loadBalance = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`${apiBase}/payouts/balance`, { credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as Partial<PortalPayoutBalance> & { error?: string };
      if (!res.ok) {
        setLoadError(body.error ?? "Could not load payouts.");
        return;
      }
      setBalance(body as PortalPayoutBalance);
    } catch {
      setLoadError("Could not load payouts.");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  // Bank accounts: prefer the dedicated list route another worker is
  // building. Its absence today (any non-2xx, including a 404) is expected,
  // not an error — fall back to the single external account the balance
  // endpoint already carries, read-only (no ⋯ menu — there is nothing this
  // page can act on through the old status endpoint alone).
  const loadBankAccounts = useCallback(async () => {
    try {
      const res = await fetch(`${connectBase}/bank-accounts`, { credentials: "include" });
      if (!res.ok) {
        setBankRoute("fallback");
        return;
      }
      const body = (await res.json().catch(() => null)) as BankAccountRow[] | null;
      if (!Array.isArray(body)) {
        setBankRoute("fallback");
        return;
      }
      setBankRows(body);
      setBankRoute("live");
    } catch {
      setBankRoute("fallback");
    }
  }, [connectBase]);

  useEffect(() => {
    setLoading(true);
    void loadBalance();
    void loadBankAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, connectBase]);

  const closeWithdraw = useCallback(() => {
    setWithdrawOpen(false);
  }, []);

  const closeVerify = useCallback(() => {
    setVerifyOpen(false);
    void loadBalance();
  }, [loadBalance]);

  const closeBankSheet = useCallback(() => {
    setBankSheetOpen(false);
    void loadBalance();
    void loadBankAccounts();
  }, [loadBalance, loadBankAccounts]);

  async function makeDefault(id: string) {
    try {
      const res = await fetch(`${connectBase}/bank-accounts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default: true }),
      });
      if (!res.ok) {
        showToast("Could not change the default account.");
        return;
      }
      void loadBankAccounts();
    } catch {
      showToast("Could not change the default account.");
    }
  }

  async function removeBank(id: string) {
    try {
      const res = await fetch(`${connectBase}/bank-accounts/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast(body.error ?? "Could not remove that account.");
        return;
      }
      void loadBankAccounts();
      void loadBalance();
    } catch {
      showToast("Could not remove that account.");
    }
  }

  const withdrawAccounts: PayoutWithdrawAccount[] = useMemo(() => {
    if (bankRoute === "live" && bankRows) {
      return bankRows.map((row) => ({
        id: row.id,
        label: row.label,
        last4: row.last4,
        kind: row.kind,
        instantEligible: row.kind === "card",
      }));
    }
    return balance ? bankToWithdrawAccounts(balance.bank) : [];
  }, [bankRoute, bankRows, balance]);

  const effectiveBankRows: BankAccountRow[] =
    bankRoute === "live" && bankRows
      ? bankRows
      : balance?.bank
        ? [
            {
              id: "default",
              kind: "bank",
              label: balance.bank.bankName,
              last4: balance.bank.last4,
              status: balance.bank.verifiedAt ? "verified" : "verifying",
              default: true,
            },
          ]
        : [];

  if (loading) {
    return <PortalRecordListSurface loading dataAttr="payouts-settings-loading" />;
  }
  if (loadError || !balance) {
    return (
      <PortalRecordListSurface
        loadError={loadError ?? "Could not load payouts."}
        onRetry={() => {
          setLoading(true);
          void loadBalance();
        }}
        dataAttr="payouts-settings-error"
      />
    );
  }

  const identityDone = balance.setup.identity === "done";
  const bankDone = balance.setup.bank === "done";
  const ready = balance.setup.ready;
  const pendingDate = formatDate(balance.schedule.nextPayoutAt);
  const pendingFact =
    balance.onTheWayCents > 0
      ? `${formatMoney(balance.onTheWayCents, balance.currency)} pending${pendingDate ? ` · arrives ${pendingDate}` : ""}`
      : null;

  const verifySheet = renderVerifySheet ? (
    renderVerifySheet({ open: verifyOpen, onClose: closeVerify })
  ) : (
    <Modal open={verifyOpen} title="Verify identity" onClose={closeVerify} panelClassName="max-w-lg" scrollableContent={false}>
      <StripeConnectEmbedded connectBase={connectBase} component="account_onboarding" onExit={closeVerify} />
    </Modal>
  );
  const bankSheet = renderBankSheet ? (
    renderBankSheet({ open: bankSheetOpen, onClose: closeBankSheet })
  ) : (
    <Modal open={bankSheetOpen} title="Add a bank account" onClose={closeBankSheet} panelClassName="max-w-lg" scrollableContent={false}>
      <StripeConnectEmbedded connectBase={connectBase} component="account_onboarding" onExit={closeBankSheet} />
    </Modal>
  );

  return (
    <div className="space-y-4" data-attr="payouts-settings-page">
      {/* Balance */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm" data-attr="payouts-settings-balance">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Available</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4 max-md:flex-col max-md:items-stretch">
          <p className="text-[32px] font-extrabold leading-none tracking-tight text-foreground" data-attr="payouts-settings-available">
            {formatMoney(balance.availableCents, balance.currency)}
          </p>
          <Button
            type="button"
            onClick={() => {
              track("payout_withdraw_started", { portal });
              setWithdrawOpen(true);
            }}
            disabled={!ready || balance.availableCents <= 0}
            data-attr="payouts-settings-withdraw"
            className="max-md:w-full"
          >
            Withdraw
          </Button>
        </div>
        {pendingFact ? (
          <p className="mt-2 text-xs text-muted" data-attr="payouts-settings-pending">
            {pendingFact}
          </p>
        ) : null}
      </div>

      {/* Set up — only until ready */}
      {!ready ? (
        <PortalSettingsSection title="Set up">
          <PortalSettingsGroup>
            <StepRow
              index={1}
              done={identityDone}
              label="Verify identity"
              action={
                identityDone ? (
                  <span className="shrink-0 text-sm font-medium text-muted">Done</span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setVerifyOpen(true)}
                    data-attr="payouts-settings-verify"
                  >
                    Verify
                  </Button>
                )
              }
            />
            <StepRow
              index={2}
              done={bankDone}
              label="Add a bank account"
              action={
                bankDone ? (
                  <span className="shrink-0 text-sm font-medium text-muted">Done</span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setBankSheetOpen(true)}
                    data-attr="payouts-settings-add-bank"
                  >
                    Add
                  </Button>
                )
              }
            />
            <StepRow
              index={3}
              done={ready}
              label="Ready to pay out"
              action={
                <span className={cn("shrink-0 text-sm font-medium", ready ? "text-foreground" : "text-muted")} data-ready-text>
                  {ready ? "Ready" : "After 1 and 2"}
                </span>
              }
            />
          </PortalSettingsGroup>
        </PortalSettingsSection>
      ) : null}
      {verifySheet}
      {bankSheet}

      {/* Bank accounts */}
      <PortalSettingsSection
        title="Bank accounts"
        action={<PortalIconAction icon={Plus} label="Add a bank account" onClick={() => setBankSheetOpen(true)} data-attr="payouts-settings-bank-add" />}
      >
        <PortalSettingsGroup>
          {effectiveBankRows.length === 0 ? (
            <div className="px-4 py-3.5 text-sm text-muted">No bank account yet</div>
          ) : (
            effectiveBankRows.map((row) => (
              <div key={row.id} className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
                <div aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/[0.08] text-primary">
                  {row.kind === "card" ? <CreditCard className="size-5" strokeWidth={1.6} /> : <Landmark className="size-5" strokeWidth={1.6} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {row.label} {row.default ? <span className="font-normal text-muted">· Default</span> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    ····{row.last4} · {row.status === "verified" ? "Verified" : "Verifying"}
                  </p>
                </div>
                {bankRoute === "live" ? (
                  <BankRowMenu rowId={row.id} label={`${row.label} ····${row.last4}`}>
                    {!row.default ? (
                      <Button type="button" variant="outline" onClick={() => makeDefault(row.id)} data-attr="payouts-settings-bank-default">
                        Make default
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" onClick={() => removeBank(row.id)} data-attr="payouts-settings-bank-remove">
                      Remove
                    </Button>
                  </BankRowMenu>
                ) : null}
              </div>
            ))
          )}
        </PortalSettingsGroup>
      </PortalSettingsSection>

      {/* Schedule */}
      <ScheduleCard
        schedule={balance.schedule}
        availableCents={balance.availableCents}
        currency={balance.currency}
        onChange={(interval) => {
          setBalance((current) => (current ? { ...current, schedule: { ...current.schedule, interval } } : current));
          void fetch(`${apiBase}/payouts/schedule`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interval }),
          })
            .then((res) => res.json().catch(() => ({})))
            .then((body: Partial<PortalPayoutBalance["schedule"]>) => {
              setBalance((current) => (current ? { ...current, schedule: { ...current.schedule, ...body } } : current));
            })
            .catch(() => {
              showToast("Could not update the schedule.");
              void loadBalance();
            });
        }}
      />

      {/* History */}
      <HistorySection
        rows={balance.history}
        currency={balance.currency}
        search=""
        onClearSearch={() => {}}
        portal={portal}
        onReceipt={(row) => {
          if (row.receiptUrl && row.receiptUrl.startsWith("https:")) {
            window.open(row.receiptUrl, "_blank", "noopener");
          }
        }}
        onRetry={(row) => {
          track("payout_withdraw_started", { portal, retry: true });
          setWithdrawOpen(true);
          // Retry prefill is intentionally not wired here yet — the settings
          // page's Withdraw sheet always opens fresh; retrying a failed
          // payout with its original amount/method stays on the existing
          // `/payments/payouts` page, which already covers it.
          void row;
        }}
      />

      <PayoutWithdrawSheet
        open={withdrawOpen}
        onClose={closeWithdraw}
        apiBase={apiBase}
        currency={balance.currency}
        availableCents={balance.availableCents}
        instantAvailableCents={balance.instantAvailableCents}
        accounts={withdrawAccounts}
        onSuccess={(result) => {
          closeWithdraw();
          track("payout_withdraw_completed", { portal, method: result.method, amount_cents: result.amountCents });
          void loadBalance();
        }}
      />
    </div>
  );
}
