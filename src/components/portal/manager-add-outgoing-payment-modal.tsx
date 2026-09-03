"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, MODAL_FIELD_LABEL_CLASS, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import {
  collectLinkedPropertyIdsForModule,
  resolvePropertyLabelForId,
} from "@/lib/manager-portfolio-access";
import { readOwnActiveManagerVendorRows, readManagerVendorCategorySettings, syncManagerVendorsFromServer, MANAGER_VENDORS_EVENT } from "@/lib/manager-vendors-storage";
import { vendorTradeForExpenseCategory } from "@/lib/axis-vendor-catalog";
import { OUTGOING_PAYMENT_CATEGORY_CODES } from "@/lib/manager-outgoing-payments";
import { isCategoryDeductible, SYSTEM_CHART_ACCOUNTS } from "@/lib/reports/categories";

function displayPropertyLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .split(" · ")[0]!
    .replace(/\s*·\s*[^·]*::[^·]*$/i, "")
    .replace(/\s+[.-]\s+[^\s]+::[^\s]+$/i, "")
    .trim();
}

const CATEGORY_OPTIONS = OUTGOING_PAYMENT_CATEGORY_CODES.map((code) => {
  const account = SYSTEM_CHART_ACCOUNTS.find((row) => row.code === code);
  return { code, label: account?.name ?? code };
});

export function ManagerAddOutgoingPaymentModal({
  open,
  onClose,
  managerUserId,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string | null;
  onSubmitted: () => void;
}) {
  const { showToast } = useAppUi();
  const [propertyTick, setPropertyTick] = useState(0);
  const [vendorTick, setVendorTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [categoryCode, setCategoryCode] = useState<string>("other_expense");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [vendorId, setVendorId] = useState("");

  useEffect(() => {
    if (!open) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
    void syncManagerVendorsFromServer();
    const onVendors = () => setVendorTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, () => setPropertyTick((n) => n + 1));
    return () => {
      window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setCategoryCode("other_expense");
    setAmount("");
    setExpenseDate(new Date().toISOString().slice(0, 10));
    setMemo("");
    setPropertyId("");
    setVendorId("");
  }, [open]);

  const vendors = useMemo(() => {
    void vendorTick;
    return readOwnActiveManagerVendorRows(managerUserId);
  }, [vendorTick, managerUserId]);

  useEffect(() => {
    if (!open) return;
    const trade = vendorTradeForExpenseCategory(categoryCode);
    if (!trade) return;
    const defaults = readManagerVendorCategorySettings(managerUserId).defaultVendorIdByTrade;
    const defaultId = defaults[trade];
    if (defaultId && vendors.some((vendor) => vendor.id === defaultId)) {
      setVendorId(defaultId);
    }
  }, [open, categoryCode, vendors]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    if (!managerUserId) return [];
    const seen = new Map<string, string>();
    for (const property of [...readExtraListingsForUser(managerUserId), ...readPendingManagerPropertiesForUser(managerUserId)]) {
      const id = property.id.trim();
      if (!id || seen.has(id)) continue;
      const label = displayPropertyLabel(
        property.buildingName.trim() || ("title" in property ? property.title : ""),
      );
      if (!label) continue;
      seen.set(id, label);
    }
    // Linked listings live in the OWNER's bucket, not this viewer's (AXI-156).
    for (const propertyId of collectLinkedPropertyIdsForModule(managerUserId, "payments")) {
      if (!propertyId || seen.has(propertyId)) continue;
      const label = displayPropertyLabel(resolvePropertyLabelForId(propertyId));
      if (!label) continue;
      seen.set(propertyId, label);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [managerUserId, propertyTick]);

  async function save() {
    const amountCents = Math.round(Number.parseFloat(amount.replace(/[^0-9.]/g, "")) * 100);
    if (!(amountCents > 0)) {
      showToast("Enter a valid amount.");
      return;
    }
    if (!memo.trim()) {
      showToast("Enter a description.");
      return;
    }
    if (isDemoModeActive()) {
      showToast("Outgoing payment saved (demo).");
      onSubmitted();
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryCode,
          amountCents,
          expenseDate,
          memo: memo.trim(),
          vendorId: vendorId || undefined,
          propertyId: propertyId || undefined,
          taxDeductible: isCategoryDeductible(categoryCode),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not save outgoing payment.");
        return;
      }
      showToast("Outgoing payment saved.");
      onSubmitted();
      onClose();
    } catch {
      showToast("Could not save outgoing payment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Add outgoing payment"
      onClose={onClose}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            disabled={saving}
            onClick={() => save()}
            data-attr="outgoing-payment-save"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">
          Log taxes, mortgage, PropLane fees, vendor invoices, and other property expenses. Vendor work-order payouts
          appear automatically when you approve completed jobs.
        </p>
        <label className="flex flex-col gap-1">
          <span className={MODAL_FIELD_LABEL_CLASS}>Category</span>
          <Select value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)} data-attr="outgoing-payment-category">
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={MODAL_FIELD_LABEL_CLASS}>Amount</span>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" data-attr="outgoing-payment-amount" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={MODAL_FIELD_LABEL_CLASS}>Date</span>
          <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} data-attr="outgoing-payment-date" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={MODAL_FIELD_LABEL_CLASS}>Description</span>
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="What was this payment for?" data-attr="outgoing-payment-memo" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={MODAL_FIELD_LABEL_CLASS}>Property</span>
          <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)} data-attr="outgoing-payment-property">
            <option value="">Portfolio (optional)</option>
            {propertyOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={MODAL_FIELD_LABEL_CLASS}>Vendor / payee</span>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} data-attr="outgoing-payment-vendor">
            <option value="">None</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
                {vendor.trade ? ` · ${vendor.trade}` : ""}
              </option>
            ))}
          </Select>
          {vendors.length === 0 ? (
            <p className="text-xs text-muted">Add vendors in Services → Vendors → Vendor settings.</p>
          ) : null}
        </label>
      </div>
    </Modal>
  );
}
