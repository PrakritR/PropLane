"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
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
import { centsToUsd } from "@/lib/reports/money";
import {
  computeDistributionCents,
  ownerDistributionBadgeTone,
  type OwnerDistribution,
} from "@/lib/manager-owner-distributions";

type DistributionDraft = {
  propertyId: string;
  periodStart: string;
  periodEnd: string;
  cashIn: string;
  cashOut: string;
  managementFee: string;
  reserveHoldback: string;
  memo: string;
};

function emptyDraft(): DistributionDraft {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { propertyId: "", periodStart: monthStart, periodEnd: monthEnd, cashIn: "", cashOut: "", managementFee: "", reserveHoldback: "", memo: "" };
}

function toCents(value: string): number {
  const n = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export type ManagerOwnerDistributionsPanelHandle = {
  openNewDistribution: () => void;
};

export const ManagerOwnerDistributionsPanel = forwardRef<ManagerOwnerDistributionsPanelHandle>(function ManagerOwnerDistributionsPanel(_props, ref) {
  const { showToast } = useAppUi();
  const [distributions, setDistributions] = useState<OwnerDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<DistributionDraft>(emptyDraft);

  useImperativeHandle(ref, () => ({ openNewDistribution: () => setModalOpen(true) }), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/manager-owner-distributions");
      const data = (await res.json()) as { distributions?: OwnerDistribution[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load distributions.");
      setDistributions(data.distributions ?? []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load distributions.");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const previewCents = useMemo(
    () =>
      computeDistributionCents({
        cashInCents: toCents(draft.cashIn),
        cashOutCents: toCents(draft.cashOut),
        managementFeeCents: toCents(draft.managementFee),
        reserveHoldbackCents: toCents(draft.reserveHoldback),
      }),
    [draft.cashIn, draft.cashOut, draft.managementFee, draft.reserveHoldback],
  );

  async function createDistribution() {
    if (!draft.propertyId.trim()) {
      showToast("Property is required.");
      return;
    }
    const res = await fetch("/api/manager-owner-distributions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        propertyId: draft.propertyId.trim(),
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
        cashInCents: toCents(draft.cashIn),
        cashOutCents: toCents(draft.cashOut),
        managementFeeCents: toCents(draft.managementFee),
        reserveHoldbackCents: toCents(draft.reserveHoldback),
        memo: draft.memo.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to create distribution.");
      return;
    }
    showToast("Distribution created.");
    setModalOpen(false);
    setDraft(emptyDraft());
    void load();
  }

  async function actOn(id: string, action: "approve" | "pay") {
    const res = await fetch(`/api/manager-owner-distributions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? `Failed to ${action} distribution.`);
      return;
    }
    showToast(action === "approve" ? "Distribution approved." : "Distribution marked paid.");
    void load();
  }

  return (
    <div className="space-y-4">
      {loading ? (
        <PortalDataTableEmpty message="Loading distributions…" icon="finance" />
      ) : distributions.length === 0 ? (
        <PortalDataTableEmpty message="No owner distributions yet." icon="finance" />
      ) : (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className={PORTAL_DATA_TABLE_SCROLL}>
            <table className={PORTAL_DATA_TABLE}>
              <colgroup>
                <col style={{ width: "26%" }} />
                <col style={{ width: "26%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "16%" }} />
              </colgroup>
              <thead>
                <tr className={PORTAL_TABLE_HEAD_ROW}>
                  <th className={MANAGER_TABLE_TH}>Property</th>
                  <th className={MANAGER_TABLE_TH}>Period</th>
                  <th className={MANAGER_TABLE_TH}>Distribution</th>
                  <th className={MANAGER_TABLE_TH}>Status</th>
                  <th className={MANAGER_TABLE_TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {distributions.map((dist) => (
                  <tr key={dist.id} className={PORTAL_TABLE_TR}>
                    <td className={PORTAL_TABLE_TD}>{dist.propertyId}</td>
                    <td className={PORTAL_TABLE_TD}>
                      {dist.periodStart} – {dist.periodEnd}
                    </td>
                    <td className={PORTAL_TABLE_TD}>{centsToUsd(dist.distributionCents)}</td>
                    <td className={PORTAL_TABLE_TD}>
                      <Badge tone={ownerDistributionBadgeTone(dist.status)}>{dist.status}</Badge>
                    </td>
                    <td className={PORTAL_TABLE_TD}>
                      {dist.status === "draft" ? (
                        <Button variant="secondary" onClick={() => actOn(dist.id, "approve")}>
                          Approve
                        </Button>
                      ) : dist.status === "approved" ? (
                        <Button variant="secondary" onClick={() => actOn(dist.id, "pay")}>
                          Mark paid
                        </Button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="New owner distribution"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => createDistribution()}>
              Create draft
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-muted">Property ID</label>
            <Input className="mt-1" value={draft.propertyId} onChange={(e) => setDraft((d) => ({ ...d, propertyId: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-muted">Period start</label>
              <Input type="date" className="mt-1" value={draft.periodStart} onChange={(e) => setDraft((d) => ({ ...d, periodStart: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted">Period end</label>
              <Input type="date" className="mt-1" value={draft.periodEnd} onChange={(e) => setDraft((d) => ({ ...d, periodEnd: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-muted">Cash in</label>
              <Input className="mt-1" value={draft.cashIn} onChange={(e) => setDraft((d) => ({ ...d, cashIn: e.target.value }))} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted">Cash out</label>
              <Input className="mt-1" value={draft.cashOut} onChange={(e) => setDraft((d) => ({ ...d, cashOut: e.target.value }))} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted">Management fee</label>
              <Input className="mt-1" value={draft.managementFee} onChange={(e) => setDraft((d) => ({ ...d, managementFee: e.target.value }))} placeholder="0.00" />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted">Reserve holdback</label>
              <Input className="mt-1" value={draft.reserveHoldback} onChange={(e) => setDraft((d) => ({ ...d, reserveHoldback: e.target.value }))} placeholder="0.00" />
            </div>
          </div>
          <div className="rounded-lg bg-accent/30 px-3 py-2 text-sm">
            Computed distribution: <strong>{centsToUsd(previewCents)}</strong>
          </div>
        </div>
      </Modal>
    </div>
  );
});
