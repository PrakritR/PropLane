"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { MoreHorizontal } from "lucide-react";
import {Input, Select} from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { formatCentsAsUsd as centsToUsd } from "@/lib/money-label-totals";
import {
  computeDispositionSplit,
  type SecurityDepositDispositionType,
  type SecurityDepositLedgerRow,
  type SecurityDepositStatus,
} from "@/lib/reports/security-deposits";

/** A plain fact, never a chip: rows carry no pills (AGENTS.md § Portal UI system). */
const STATUS_LABEL: Record<SecurityDepositStatus, string> = {
  held: "Held",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  forfeited: "Forfeited",
  applied_to_damages: "Applied to damages",
};

type DisposeDraft = {
  dispositionType: SecurityDepositDispositionType;
  withhold: string;
  memo: string;
};

function emptyDisposeDraft(): DisposeDraft {
  return { dispositionType: "full_refund", withhold: "0", memo: "" };
}

export function ManagerSecurityDepositsPanel() {
  const { showToast } = useAppUi();
  const [deposits, setDeposits] = useState<SecurityDepositLedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [disposeTarget, setDisposeTarget] = useState<SecurityDepositLedgerRow | null>(null);
  const [draft, setDraft] = useState<DisposeDraft>(emptyDisposeDraft);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/security-deposits");
      const data = (await res.json()) as { deposits?: SecurityDepositLedgerRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load deposits.");
      setDeposits(data.deposits ?? []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load deposits.");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  function openDispose(deposit: SecurityDepositLedgerRow) {
    setDisposeTarget(deposit);
    setDraft(emptyDisposeDraft());
  }

  async function submitDispose() {
    if (!disposeTarget) return;
    const withholdCents = Math.max(0, Math.round(Number.parseFloat(draft.withhold.replace(/[^0-9.]/g, "")) * 100));
    const split = computeDispositionSplit(disposeTarget.amountHeldCents, withholdCents);
    const res = await fetch(`/api/security-deposits/${disposeTarget.id}/dispose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dispositionType: draft.dispositionType,
        refundCents: split.refundCents,
        withholdCents: split.withholdCents,
        memo: draft.memo.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to dispose deposit.");
      return;
    }
    showToast("Deposit disposition recorded.");
    setDisposeTarget(null);
    void load();
  }

  const previewSplit =
    disposeTarget && draft.dispositionType !== "full_withhold"
      ? computeDispositionSplit(
          disposeTarget.amountHeldCents,
          Math.max(0, Math.round(Number.parseFloat(draft.withhold.replace(/[^0-9.]/g, "")) * 100)),
        )
      : disposeTarget
        ? computeDispositionSplit(disposeTarget.amountHeldCents, disposeTarget.amountHeldCents)
        : null;

  return (
    <div className="space-y-4">
      {loading ? (
        <PortalDataTableEmpty message="Loading security deposits…" icon="finance" />
      ) : deposits.length === 0 ? (
        <PortalDataTableEmpty message="No security deposits on file yet. Paid deposit charges appear here automatically." icon="finance" />
      ) : (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className={PORTAL_DATA_TABLE_SCROLL}>
            <table className={PORTAL_DATA_TABLE}>
              <thead>
                <tr className={PORTAL_TABLE_HEAD_ROW}>
                  <th className={MANAGER_TABLE_TH}>Resident</th>
                  <th className={MANAGER_TABLE_TH}>Received</th>
                  <th className={MANAGER_TABLE_TH}>Held</th>
                  <th className={MANAGER_TABLE_TH}>Status</th>
                  <th className={MANAGER_TABLE_TH}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((deposit) => (
                  <tr key={deposit.id} className={PORTAL_TABLE_TR}>
                    <td className={`${PORTAL_TABLE_TD} truncate`} title={deposit.residentEmail}>{deposit.residentEmail}</td>
                    <td className={PORTAL_TABLE_TD}>{deposit.receivedDate}</td>
                    <td className={`${PORTAL_TABLE_TD} tabular-nums`}>{centsToUsd(deposit.amountHeldCents)}</td>
                    <td className={PORTAL_TABLE_TD}>
                      {STATUS_LABEL[deposit.status] ?? deposit.status.replace(/_/g, " ")}
                    </td>
                    <td className={`${PORTAL_TABLE_TD} text-right`}>
                      {deposit.status === "held" || deposit.dispositionType ? (
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button type="button" variant="ghost" aria-label={`${deposit.residentEmail} deposit actions`} className={RECORD_ACTION_TRIGGER_BUTTON_CLASS} data-attr="deposit-actions">
                              <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {deposit.status === "held" ? (
                              <DropdownMenuItem onSelect={() => openDispose(deposit)} data-attr="deposit-dispose">Dispose</DropdownMenuItem>
                            ) : null}
                            {deposit.dispositionType ? (
                              <DropdownMenuItem
                                onSelect={() => window.location.assign(`/api/reports/deposit-disposition/export?depositId=${encodeURIComponent(deposit.id)}`)}
                                data-attr="deposit-disposition-pdf"
                              >
                                Download PDF
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(disposeTarget)}
        onClose={() => setDisposeTarget(null)}
        title="Dispose security deposit"
        description={
          disposeTarget
            ? `Held balance ${centsToUsd(disposeTarget.amountHeldCents)} for ${disposeTarget.residentEmail}`
            : undefined
        }
        footer={
          disposeTarget ? (
            <ModalFooter>
              <Button variant="primary" onClick={() => submitDispose()} data-attr="deposit-dispose-submit">
                Record disposition
              </Button>
            </ModalFooter>
          ) : undefined
        }
      >
        {disposeTarget ? (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-muted">Disposition type</label>
              <Select
               
                value={draft.dispositionType}
                onChange={(e) => setDraft((d) => ({ ...d, dispositionType: e.target.value as SecurityDepositDispositionType }))}
              >
                <option value="full_refund">Full refund</option>
                <option value="itemized_partial">Itemized partial withhold</option>
                <option value="full_withhold">Full withhold</option>
              </Select>
            </div>
            {draft.dispositionType !== "full_refund" ? (
              <div>
                <label className="text-xs font-semibold text-muted">Withhold amount</label>
                <Input
                  className="mt-1"
                  value={draft.withhold}
                  onChange={(e) => setDraft((d) => ({ ...d, withhold: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
            ) : null}
            <div>
              <label className="text-xs font-semibold text-muted">Memo</label>
              <Input className="mt-1" value={draft.memo} onChange={(e) => setDraft((d) => ({ ...d, memo: e.target.value }))} />
            </div>
            {previewSplit ? (
              <p className="rounded-xl border border-border bg-accent/20 px-3 py-2 text-xs text-muted">
                Refund {centsToUsd(previewSplit.refundCents)} · Withhold {centsToUsd(previewSplit.withholdCents)}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
