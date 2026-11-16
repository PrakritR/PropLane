"use client";

import { AlertTriangle, CalendarDays, Landmark, Lock, Percent, Plus, RefreshCw, UserRound, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalStatStrip } from "@/components/portal/portal-stat-strip";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS, Modal, ModalFooter, PORTAL_MODAL_FORM_FIELD_CLASS } from "@/components/ui/modal";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { bpsToPercentInput, centsToDollarsInput, parseDollarsToCents, parsePercentToBps } from "@/lib/dollar-input";
import type { AdminPartyBalance, AdminPayoutsView, AdminWorkspaceSplits } from "@/lib/managed-finance/admin-payouts.server";
import { formatManagedUsd } from "@/lib/managed-finance/format";
import { DEFAULT_SPLIT_KINDS, type SplitRule } from "@/lib/managed-finance/splits";
import { formatPacificDate } from "@/lib/pacific-time";

const URL_BASE = "/api/admin/payouts";
const TIMEOUT_MS = 25_000;

type Payee = { userId: string; label: string; kind: "member" | "vendor" };

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T & { error?: string } }> {
  try {
    const res = await fetchWithTimeout(url, { credentials: "include", ...init }, TIMEOUT_MS);
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as T & { error?: string } };
  } catch {
    return { ok: false, data: { error: "That didn't go through. Try again." } as T & { error?: string } };
  }
}

const post = (body: Record<string, unknown>) => call<Record<string, unknown>>(URL_BASE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** "15% of rent" / "$50 per stay": the rule in words, the same line on the editor and the owner's statement. */
export function describeSplitRule(rule: Pick<SplitRule, "ruleKind" | "bps" | "fixedCents" | "appliesTo">): string {
  const stayOnly = rule.appliesTo.length > 0 && rule.appliesTo.every((k) => k === "stay_total");
  if (rule.ruleKind === "percent") return `${bpsToPercentInput(rule.bps ?? 0)}% of the owner's share`;
  return `${formatManagedUsd(rule.fixedCents ?? 0)} per ${stayOnly ? "stay" : "payment"}`;
}

const shortDate = (value: string) => formatPacificDate(value, { month: "short", day: "numeric" });

function Band({ label, count, children }: { label: string; count?: number; children?: React.ReactNode }) {
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

/** Admin > Money > Payouts: every PropLane-held balance, payout split rules per managed workspace, held and failed payouts, the audit. */
export function AdminPayoutsPanel() {
  const [state, setState] = useState<{ data: AdminPayoutsView | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void call<AdminPayoutsView>(URL_BASE).then((r) => {
      if (!live) return;
      setState(r.ok ? { data: r.data, loading: false, error: null } : { data: null, loading: false, error: r.data.error ?? "Could not load payouts." });
    });
    return () => {
      live = false;
    };
  }, [tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const data = state.data;

  // Hold / release.
  const [holdTarget, setHoldTarget] = useState<AdminPartyBalance | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [holdError, setHoldError] = useState<string | null>(null);
  const placeHold = async () => {
    if (!holdTarget) return;
    const r = await post({ action: "hold", partyId: holdTarget.partyId, workspaceId: holdTarget.workspaceId, reason: holdReason });
    if (!r.ok) return void setHoldError(r.data.error ?? "Could not place the hold.");
    setHoldTarget(null);
    setHoldReason("");
    setNotice("Withdrawals are on hold for that account");
    reload();
  };
  const release = async (holdId: string) => {
    const r = await post({ action: "release", holdId });
    setNotice(r.ok ? "Hold released" : (r.data.error ?? "Could not release the hold."));
    reload();
  };
  const retryCheck = async () => {
    const r = await post({ action: "retry_check" });
    setNotice(r.ok ? "Payout check re-run" : (r.data.error ?? "Could not re-run the check."));
    reload();
  };

  // Split rule editor.
  const [ruleWorkspace, setRuleWorkspace] = useState<AdminWorkspaceSplits | null>(null);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [payee, setPayee] = useState("");
  const [ruleKind, setRuleKind] = useState<"percent" | "fixed">("percent");
  const [amountText, setAmountText] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);
  const openRule = async (w: AdminWorkspaceSplits) => {
    setRuleWorkspace(w);
    setPayee("");
    setRuleKind("percent");
    setAmountText("");
    setRuleError(null);
    const r = await call<{ payees: Payee[] }>(`${URL_BASE}?payees=${encodeURIComponent(w.workspaceId)}`);
    if (r.ok) setPayees(r.data.payees ?? []);
    else setRuleError(r.data.error ?? "Could not load the team.");
  };
  const saveRule = async () => {
    if (!ruleWorkspace) return;
    const chosen = payees.find((p) => p.userId === payee);
    const bps = ruleKind === "percent" ? parsePercentToBps(amountText, false) : null;
    const fixedCents = ruleKind === "fixed" ? parseDollarsToCents(amountText) : null;
    if (!chosen) return void setRuleError("Choose who is paid.");
    if (bps === null && fixedCents === null) return void setRuleError(ruleKind === "percent" ? "Enter a percent, like 15." : "Enter a dollar amount, like 50.00.");
    const r = await post({
      action: "rule_create", workspaceId: ruleWorkspace.workspaceId, ruleKind, payeeKind: chosen.kind, payeeUserId: chosen.userId, bps, fixedCents,
      appliesTo: ruleKind === "fixed" ? ["stay_total"] : [...DEFAULT_SPLIT_KINDS],
    });
    if (!r.ok) return void setRuleError(r.data.error ?? "Could not save the rule.");
    setRuleWorkspace(null);
    setNotice("Split rule added. It applies to money received from now on");
    reload();
  };
  const endRule = async (workspaceId: string, ruleId: string) => {
    const r = await post({ action: "rule_end", workspaceId, ruleId });
    setNotice(r.ok ? "Split rule ended. Payments already split are unchanged" : (r.data.error ?? "Could not end the rule."));
    reload();
  };

  // Bill approval threshold.
  const [thresholdWorkspace, setThresholdWorkspace] = useState<AdminWorkspaceSplits | null>(null);
  const [thresholdText, setThresholdText] = useState("");
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const saveThreshold = async () => {
    if (!thresholdWorkspace) return;
    const cents = parseDollarsToCents(thresholdText, true);
    if (cents === null) return void setThresholdError("Enter an amount, like 500.00, or 0 to ask every time.");
    const r = await post({ action: "threshold", workspaceId: thresholdWorkspace.workspaceId, cents });
    if (!r.ok) return void setThresholdError(r.data.error ?? "Could not save.");
    setThresholdWorkspace(null);
    reload();
  };

  return (
    <ManagerPortalPageShell title="Payouts" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <div className="mb-2 flex items-center justify-end gap-0.5">
        <PortalIconAction icon={RefreshCw} label="Re-run payout check" data-attr="admin-payouts-retry" onClick={() => retryCheck()} />
      </div>
      {notice ? <p role="status" className="mb-3 text-sm font-medium text-foreground" data-attr="admin-payouts-notice">{notice}</p> : null}
      {state.loading && !data ? <PortalRecordListSurface loading dataAttr="admin-payouts-loading" /> : null}
      {state.error ? <PortalRecordListSurface loadError={state.error} onRetry={reload} dataAttr="admin-payouts-error" /> : null}
      {data ? (
        <div className="space-y-5">
          <PortalStatStrip
            dataAttr="admin-payouts-strip"
            items={[
              { id: "fee", label: "PropLane fee earned", value: formatManagedUsd(data.totals.feeEarnedCents), tone: "ok" },
              { id: "owed", label: "Owed to people", value: formatManagedUsd(data.totals.owedToPartiesCents) },
              { id: "available", label: "Available to withdraw", value: formatManagedUsd(data.totals.availableCents) },
              { id: "pending", label: "Pending", value: formatManagedUsd(data.totals.pendingCents) },
            ]}
          />

          {data.problems.length > 0 ? (
            <div data-attr="admin-payouts-problems">
              <Band label="Needs attention" count={data.problems.length} />
              <PortalRecordListSurface dataAttr="admin-payouts-problems-list">
                {data.problems.map((p) => (
                  <PortalEntryRow
                    key={p.id}
                    tile={{ kind: "glyph", icon: AlertTriangle }}
                    title={p.partyLabel}
                    place={p.reason}
                    facts={[{ icon: CalendarDays, label: shortDate(p.createdAt), srLabel: "Date" }, { label: p.status, srLabel: "Status" }]}
                    figure={{ value: formatManagedUsd(p.amountCents), tone: "bad" }}
                    dataAttr="admin-payouts-problem-row"
                  />
                ))}
              </PortalRecordListSurface>
            </div>
          ) : null}

          <div data-attr="admin-payouts-balances">
            <Band label="Balances" count={data.parties.length} />
            <PortalRecordListSurface isEmpty={data.parties.length === 0} emptyCard={{ title: "No balances yet" }} dataAttr="admin-payouts-balances-list">
              {data.parties.map((p) => (
                <RowMenu
                  key={`${p.partyId}:${p.workspaceId ?? ""}`}
                  scope={p.label}
                  actions={
                    p.holdId ? (
                      <Button type="button" variant="outline" data-attr="admin-payouts-release" data-record-action-id="release" onClick={() => release(p.holdId!)}>
                        Release hold
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        data-attr="admin-payouts-hold"
                        data-record-action-id="hold"
                        onClick={() => {
                          setHoldTarget(p);
                          setHoldReason("");
                          setHoldError(null);
                        }}
                      >
                        Hold withdrawals
                      </Button>
                    )
                  }
                >
                  <PortalEntryRow
                    tile={{ kind: "glyph", icon: p.kind === "vendor" ? Wallet : UserRound }}
                    title={p.label}
                    place={p.workspaceName}
                    facts={[
                      { label: `Available ${formatManagedUsd(p.availableCents)}`, srLabel: "Available" },
                      ...(p.pendingCents > 0 ? [{ label: `Pending ${formatManagedUsd(p.pendingCents)}`, srLabel: "Pending" }] : []),
                      ...(p.holdId ? [{ icon: Lock, label: p.holdReason ?? "On hold", srLabel: "Hold" }] : []),
                    ]}
                    figure={{ value: formatManagedUsd(p.owedCents) }}
                    omitActionView
                    dataAttr="admin-payouts-balance-row"
                  />
                </RowMenu>
              ))}
            </PortalRecordListSurface>
          </div>

          <div data-attr="admin-payouts-splits">
            <Band label="Payout splits" count={data.workspaces.length} />
            {data.workspaces.length === 0 ? (
              <PortalRecordListSurface isEmpty emptyCard={{ title: "No managed workspaces" }} dataAttr="admin-payouts-splits-empty" />
            ) : (
              data.workspaces.map((w) => (
                <div key={w.workspaceId} className="mb-3" data-attr="admin-payouts-workspace">
                  <Band label={w.workspaceName}>
                    <PortalIconAction
                      icon={Landmark}
                      label="Bill approval amount"
                      ariaLabel={`Bill approval amount for ${w.workspaceName}`}
                      data-attr="admin-payouts-threshold"
                      onClick={() => {
                        setThresholdWorkspace(w);
                        setThresholdText(centsToDollarsInput(w.billApprovalThresholdCents));
                        setThresholdError(null);
                      }}
                    />
                    <PortalIconAction icon={Plus} label="Add split rule" ariaLabel={`Add a split rule to ${w.workspaceName}`} data-attr="admin-payouts-add-rule" onClick={() => openRule(w)} />
                  </Band>
                  <PortalRecordListSurface dataAttr="admin-payouts-rules-list">
                    <PortalEntryRow
                      tile={{ kind: "glyph", icon: Percent }}
                      title="PropLane fee"
                      place={w.feeLine}
                      dataAttr="admin-payouts-fee-row"
                    />
                    {w.rules.map((r) => (
                      <RowMenu
                        key={r.id}
                        scope={r.payeeLabel}
                        actions={
                          <Button type="button" variant="danger" data-attr="admin-payouts-end-rule" data-record-action-id="delete" onClick={() => endRule(w.workspaceId, r.id)}>
                            End rule
                          </Button>
                        }
                      >
                        <PortalEntryRow
                          tile={{ kind: "glyph", icon: UserRound }}
                          title={r.payeeLabel}
                          place={describeSplitRule(r)}
                          facts={[{ icon: CalendarDays, label: `Since ${shortDate(r.effectiveFrom)}`, srLabel: "Effective" }]}
                          omitActionView
                          dataAttr="admin-payouts-rule-row"
                        />
                      </RowMenu>
                    ))}
                  </PortalRecordListSurface>
                </div>
              ))
            )}
          </div>

          {data.audit.length > 0 ? (
            <div data-attr="admin-payouts-audit">
              <Band label="Recent actions" count={data.audit.length} />
              <PortalRecordListSurface dataAttr="admin-payouts-audit-list">
                {data.audit.map((a) => (
                  <PortalEntryRow
                    key={a.id}
                    tile={{ kind: "glyph", icon: CalendarDays }}
                    title={a.action.replace(/_/g, " ")}
                    place={[a.actorLabel, a.workspaceName].filter(Boolean).join(" · ")}
                    facts={[{ icon: CalendarDays, label: shortDate(a.createdAt), srLabel: "Date" }]}
                    dataAttr="admin-payouts-audit-row"
                  />
                ))}
              </PortalRecordListSurface>
            </div>
          ) : null}
        </div>
      ) : null}

      <Modal
        open={holdTarget !== null}
        title="Hold withdrawals"
        onClose={() => setHoldTarget(null)}
        dataAttr="admin-payouts-hold-modal"
        footer={
          <ModalFooter>
            <Button type="button" data-attr="admin-payouts-hold-save" onClick={() => placeHold()}>
              Hold
            </Button>
          </ModalFooter>
        }
      >
        <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <span className={MODAL_FIELD_LABEL_CLASS}>Reason</span>
          <Input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} data-attr="admin-payouts-hold-reason" autoFocus />
        </label>
        {holdError ? <p className="mt-2 text-[13px] text-red-600" role="alert">{holdError}</p> : null}
      </Modal>

      <Modal
        open={ruleWorkspace !== null}
        title="Add split rule"
        onClose={() => setRuleWorkspace(null)}
        dataAttr="admin-payouts-rule-modal"
        footer={
          <ModalFooter>
            <Button type="button" data-attr="admin-payouts-rule-save" onClick={() => saveRule()}>
              Save
            </Button>
          </ModalFooter>
        }
      >
        <div className="flex flex-col gap-3">
          <FieldSingleSelect
            label="Paid to"
            options={payees.map((p) => ({ value: p.userId, label: p.label }))}
            value={payee}
            onChange={setPayee}
            placeholder="Choose a person"
            searchPlaceholder="Search people"
            dataAttr="admin-payouts-rule-payee"
          />
          <FieldSingleSelect
            label="Split by"
            options={[{ value: "percent", label: "Percent of the owner's share" }, { value: "fixed", label: "Fixed amount per stay" }]}
            value={ruleKind}
            onChange={(v) => setRuleKind(v === "fixed" ? "fixed" : "percent")}
            dataAttr="admin-payouts-rule-kind"
          />
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>{ruleKind === "percent" ? "Percent" : "Amount ($)"}</span>
            <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} data-attr="admin-payouts-rule-amount" />
          </label>
        </div>
        {ruleError ? <p className="mt-2 text-[13px] text-red-600" role="alert">{ruleError}</p> : null}
      </Modal>

      <Modal
        open={thresholdWorkspace !== null}
        title="Bill approval amount"
        onClose={() => setThresholdWorkspace(null)}
        dataAttr="admin-payouts-threshold-modal"
        footer={
          <ModalFooter>
            <Button type="button" data-attr="admin-payouts-threshold-save" onClick={() => saveThreshold()}>
              Save
            </Button>
          </ModalFooter>
        }
      >
        <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <span className={MODAL_FIELD_LABEL_CLASS}>Owner approves bills above ($)</span>
          <Input inputMode="decimal" value={thresholdText} onChange={(e) => setThresholdText(e.target.value)} data-attr="admin-payouts-threshold-amount" autoFocus />
        </label>
        {thresholdError ? <p className="mt-2 text-[13px] text-red-600" role="alert">{thresholdError}</p> : null}
      </Modal>
    </ManagerPortalPageShell>
  );
}

/** One row's ⋯: the shared per-record action scope (same wiring as the vendor documents rows). */
function RowMenu({ scope, actions, children }: { scope: string; actions: React.ReactNode; children: React.ReactNode }) {
  return <RecordActionContext.Provider value={{ scope, clear: () => {}, actions }}>{children}</RecordActionContext.Provider>;
}
