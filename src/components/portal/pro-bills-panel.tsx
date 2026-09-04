"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { centsToUsd } from "@/lib/reports/money";
import { managerBillBadgeTone, type ManagerBill } from "@/lib/manager-bills";
import { Badge } from "@/components/ui/badge";

type BillDraft = {
  description: string;
  amount: string;
  dueDate: string;
  categoryCode: string;
};

function emptyDraft(): BillDraft {
  return {
    description: "",
    amount: "",
    dueDate: new Date().toISOString().slice(0, 10),
    categoryCode: "maintenance",
  };
}

export type ManagerBillsPanelHandle = {
  openAddBill: () => void;
};

export const ManagerBillsPanel = forwardRef<ManagerBillsPanelHandle>(function ManagerBillsPanel(_props, ref) {
  const { showToast } = useAppUi();
  const [bills, setBills] = useState<ManagerBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<BillDraft>(emptyDraft);

  useImperativeHandle(ref, () => ({ openAddBill: () => setModalOpen(true) }), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/manager-bills");
      const data = (await res.json()) as { bills?: ManagerBill[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load bills.");
      setBills(data.bills ?? []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load bills.");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBill() {
    const amountCents = Math.round(Number.parseFloat(draft.amount.replace(/[^0-9.]/g, "")) * 100);
    if (!draft.description.trim() || !Number.isFinite(amountCents) || amountCents <= 0) {
      showToast("Description and amount are required.");
      return;
    }
    const res = await fetch("/api/manager-bills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: draft.description.trim(),
        amountCents,
        dueDate: draft.dueDate,
        categoryCode: draft.categoryCode,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to create bill.");
      return;
    }
    showToast("Bill created.");
    setModalOpen(false);
    setDraft(emptyDraft());
    void load();
  }

  async function actOnBill(id: string, action: "approve" | "pay") {
    const res = await fetch(`/api/manager-bills/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? `Failed to ${action} bill.`);
      return;
    }
    showToast(action === "approve" ? "Bill approved." : "Bill marked paid.");
    void load();
  }

  return (
    <div className="space-y-4">
      {loading ? (
        <PortalDataTableEmpty message="Loading bills…" icon="finance" />
      ) : bills.length === 0 ? (
        <PortalDataTableEmpty message="No bills yet." icon="finance" />
      ) : (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className={PORTAL_DATA_TABLE_SCROLL}>
            <table className={PORTAL_DATA_TABLE}>
              <colgroup>
                <col style={{ width: "28%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "30%" }} />
              </colgroup>
              <thead>
                <tr className={PORTAL_TABLE_HEAD_ROW}>
                  <th className={MANAGER_TABLE_TH}>Description</th>
                  <th className={MANAGER_TABLE_TH}>Amount</th>
                  <th className={MANAGER_TABLE_TH}>Due</th>
                  <th className={MANAGER_TABLE_TH}>Status</th>
                  <th className={MANAGER_TABLE_TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => (
                  <tr key={bill.id} className={PORTAL_TABLE_TR}>
                    <td className={PORTAL_TABLE_TD}>{bill.description}</td>
                    <td className={PORTAL_TABLE_TD}>{centsToUsd(bill.amountCents)}</td>
                    <td className={PORTAL_TABLE_TD}>{bill.dueDate ?? "—"}</td>
                    <td className={PORTAL_TABLE_TD}>
                      <Badge tone={managerBillBadgeTone(bill.status)}>{bill.status.replace(/_/g, " ")}</Badge>
                    </td>
                    <td className={PORTAL_TABLE_TD}>
                      {bill.status === "pending_approval" || bill.status === "draft" ? (
                        <Button variant="secondary" onClick={() => actOnBill(bill.id, "approve")}>
                          Approve
                        </Button>
                      ) : bill.status === "approved" || bill.status === "scheduled" ? (
                        <Button variant="secondary" onClick={() => actOnBill(bill.id, "pay")}>
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
        title="Add bill"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => createBill()}>
              Create bill
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-muted">Description</label>
            <Input className="mt-1" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted">Amount</label>
            <Input className="mt-1" value={draft.amount} onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} placeholder="150.00" />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted">Due date</label>
            <Input className="mt-1" type="date" value={draft.dueDate} onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))} />
          </div>
        </div>
      </Modal>
    </div>
  );
});
