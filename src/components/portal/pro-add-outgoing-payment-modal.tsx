"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
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
  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);

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
    setStepIdx(0);
    setStepError(null);
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

  function parsedAmountCents() {
    return Math.round(Number.parseFloat(amount.replace(/[^0-9.]/g, "")) * 100);
  }

  async function save() {
    const amountCents = parsedAmountCents();
    if (!(amountCents > 0)) {
      setStepError("Enter a valid amount.");
      setStepIdx(0);
      return;
    }
    if (!memo.trim()) {
      setStepError("Enter a description.");
      setStepIdx(0);
      return;
    }
    setStepError(null);
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

  if (!open) return null;

  const categoryLabel = CATEGORY_OPTIONS.find((option) => option.code === categoryCode)?.label ?? categoryCode;
  const propertyLabel = propertyOptions.find((option) => option.id === propertyId)?.label ?? "Portfolio";
  const vendorLabel = vendors.find((vendor) => vendor.id === vendorId)?.name ?? "None";
  const amountCents = parsedAmountCents();
  const amountLabel = amountCents > 0 ? `$${(amountCents / 100).toFixed(2)}` : "Not set";
  const whatIncomplete = !(amountCents > 0) || !memo.trim();
  const steps: AddWorkspaceStep[] = [
    { id: "what", label: "What", summary: whatIncomplete ? "Amount" : `${categoryLabel} · ${amountLabel}`, incomplete: whatIncomplete },
    { id: "where", label: "Where", summary: `${propertyLabel} · ${vendorLabel}` },
    { id: "review", label: "Review", summary: "Ready" },
  ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  return (
    <AddWorkspace
      title="Add payment"
      steps={steps}
      current={current}
      onJump={(index) => {
        setStepError(null);
        setStepIdx(index);
      }}
      onClose={onClose}
      dirty={Boolean(amount.trim() || memo.trim() || propertyId || vendorId)}
      discardTitle="Discard this payment?"
      assistantContext="Add an outgoing payment for taxes, mortgage, fees, or a vendor invoice."
      assistantScopeKey="Add outgoing payment"
      sidePanel={
        <PreviewPanel
          title="Payment"
          name={categoryLabel}
          facts={[
            { label: "Category", value: categoryLabel },
            { label: "Amount", value: amountLabel, warn: !(amountCents > 0) },
            { label: "Vendor", value: vendorLabel },
          ]}
          creates={[
            { tone: "yes", text: "Outgoing pending payment" },
            { tone: "no", text: "Vendor payouts from completed services still post on their own" },
          ]}
        />
      }
      lastLabel="Save"
      lastDisabled={saving}
      nextDisabled={stepId === "what" && whatIncomplete}
      onBeforeNext={() => {
        if (stepId === "what" && whatIncomplete) {
          setStepError(!(amountCents > 0) ? "Enter a valid amount." : "Enter a description.");
          return false;
        }
        setStepError(null);
        return true;
      }}
      busy={saving}
      onFinish={() => void save()}
      dataAttrPrefix="outgoing-payment"
      finishDataAttr="outgoing-payment-save"
      footerNote={stepError ? <span className="text-sm text-rose-600">{stepError}</span> : null}
    >
      {stepId === "what" ? (
        <StepColumn>
          <StepHeading title="Payment" />
          <WizardSelect
            label="Category"
            value={categoryCode}
            onChange={setCategoryCode}
            options={CATEGORY_OPTIONS.map((option) => ({ value: option.code, label: option.label }))}
            dataAttr="outgoing-payment-category"
          />
          <WizardField label="Amount" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="185" data-attr="outgoing-payment-amount" />
          </WizardField>
          <WizardField label="Date">
            <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} data-attr="outgoing-payment-date" />
          </WizardField>
          <WizardField label="Description" required>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Plumbing invoice" data-attr="outgoing-payment-memo" />
          </WizardField>
        </StepColumn>
      ) : null}
      {stepId === "where" ? (
        <StepColumn>
          <StepHeading title="Where" />
          <WizardSelect
            label="Property"
            value={propertyId}
            onChange={setPropertyId}
            options={[{ value: "", label: "Portfolio" }, ...propertyOptions.map((option) => ({ value: option.id, label: option.label }))]}
            dataAttr="outgoing-payment-property"
          />
          <WizardSelect
            label="Vendor"
            value={vendorId}
            onChange={setVendorId}
            options={[{ value: "", label: "None" }, ...vendors.map((vendor) => ({ value: vendor.id, label: vendor.trade ? `${vendor.name} · ${vendor.trade}` : vendor.name }))]}
            dataAttr="outgoing-payment-vendor"
          />
        </StepColumn>
      ) : null}
      {stepId === "review" ? (
        <StepColumn>
          <StepHeading title="Review" />
          <PreviewPanel
            title="Outgoing"
            name={categoryLabel}
            facts={[
              { label: "Category", value: categoryLabel },
              { label: "Amount", value: amountLabel },
              { label: "Property", value: propertyLabel },
              { label: "Vendor", value: vendorLabel },
            ]}
            creates={[{ tone: "yes", text: "Saves an outgoing payment" }]}
          />
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
