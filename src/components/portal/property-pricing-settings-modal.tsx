"use client";

import { useEffect, useMemo, useState } from "react";
import { PortalPropertySectionSettingsModal } from "@/components/portal/portal-property-section-settings-modal";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MoneyInput, ToggleRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  markPaymentFieldOwn,
  paymentSettingsFieldScope,
  paymentSettingsScopeLabel,
  resetPaymentFieldToWorkspace,
  type PaymentSettingsField,
} from "@/lib/property-payment-settings-scope";
import {
  SERVICE_FEE_PAYER_OPTION_LABELS,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import {
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
type WorkspacePaymentPublic = {
  serviceFeePayer?: ServiceFeePayer | null;
};

const DUE_DAY_OPTIONS = [
  { value: "first_of_month", label: "1st of the month" },
  { value: "last_of_month", label: "Last day of the month" },
];

const PAYER_OPTIONS = (["resident", "manager", "proplane"] as ServiceFeePayer[]).map((value) => ({
  value,
  label: SERVICE_FEE_PAYER_OPTION_LABELS[value],
}));

type Props = {
  open: boolean;
  onClose: () => void;
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onSaved: () => void;
  showToast: (message: string) => void;
  workspacePayment?: WorkspacePaymentPublic | null;
};

/**
 * Property Pricing gear — collecting, rent & late fees, and processing fee rows
 * (C2-PRC8 / C2-PS11 / C2-PR9 / C2-PS1).
 */
export function PropertyPricingSettingsModal({
  open,
  onClose,
  sub,
  saveTarget,
  managerUserId,
  propertyLabel,
  onSaved,
  showToast,
  workspacePayment = null,
}: Props) {
  const [draft, setDraft] = useState(() => normalizeManagerListingSubmissionV1(sub));

  useEffect(() => {
    if (open) setDraft(normalizeManagerListingSubmissionV1(sub));
  }, [open, sub]);

  const patch = (next: Partial<ManagerListingSubmissionV1>, field?: PaymentSettingsField) => {
    setDraft((prev) => {
      let merged = { ...prev, ...next };
      if (field) merged = markPaymentFieldOwn(merged, field);
      return merged;
    });
  };

  const save = () => {
    const normalized = normalizeManagerListingSubmissionV1(draft);
    if (!persistManagerListingSubmission(saveTarget, managerUserId, normalized)) {
      showToast("Could not save payment settings.");
      return;
    }
    onSaved();
    onClose();
    showToast("Payment settings saved.");
  };

  const showCoverageCode = draft.serviceFeePayer === "proplane";

  const scopeRow = (field: PaymentSettingsField, label: string, control: React.ReactNode) => {
    const scope = paymentSettingsFieldScope(draft, field, workspacePayment);
    const canReset = scope === "own";
    return (
      <div className="group flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <span className="text-[14px] font-semibold text-foreground">{label}</span>
          <p className="text-[12px] font-semibold text-muted" data-rp-src>
            {paymentSettingsScopeLabel(scope)}
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2 sm:max-w-[55%] sm:justify-end">
          {control}
          {canReset ? (
            <button
              type="button"
              className="text-[12px] font-bold text-primary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100"
              onClick={() =>
                setDraft((prev) => resetPaymentFieldToWorkspace(prev, field, workspacePayment))
              }
              data-attr={`property-pricing-settings-reset-${field}`}
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const groups = useMemo(
    () => [
      {
        title: "Collecting",
        rows: (
          <>
            {scopeRow(
              "serviceFeePayer",
              "Processing fee paid by",
              <FieldSingleSelect
                label="Processing fee paid by"
                options={PAYER_OPTIONS}
                value={draft.serviceFeePayer ?? workspacePayment?.serviceFeePayer ?? "resident"}
                onChange={(v) => patch({ serviceFeePayer: v as ServiceFeePayer }, "serviceFeePayer")}
                dataAttr="property-pricing-settings-fee-payer"
              />,
            )}
            {showCoverageCode ? (
              <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[14px] font-semibold text-foreground">Coverage code</span>
                <input
                  className="h-9 w-full max-w-[220px] rounded-lg border border-border bg-background px-2 text-[14px] font-semibold text-foreground"
                  value={draft.serviceFeeWaiverCode ?? ""}
                  onChange={(e) => patch({ serviceFeeWaiverCode: e.target.value })}
                  data-attr="property-pricing-settings-coverage-code"
                  aria-label="Coverage code"
                />
              </div>
            ) : null}
          </>
        ),
      },
      {
        title: "Rent & late fees",
        rows: (
          <>
            {scopeRow(
              "rentDueDayMode",
              "Rent due",
              <FieldSingleSelect
                label="Rent due"
                options={DUE_DAY_OPTIONS}
                value={draft.rentDueDayMode ?? "first_of_month"}
                onChange={(v) =>
                  patch({ rentDueDayMode: v as "first_of_month" | "last_of_month" }, "rentDueDayMode")
                }
                dataAttr="property-pricing-settings-due-day"
              />,
            )}
            {scopeRow(
              "lateFeeEnabled",
              "Automatic late fees",
              <ToggleRow
                label="Automatic late fees"
                checked={draft.lateFeeEnabled !== false}
                onChange={(on) => patch({ lateFeeEnabled: on }, "lateFeeEnabled")}
                dataAttr="property-pricing-settings-late-on"
              />,
            )}
            {draft.lateFeeEnabled !== false ? (
              <>
                {scopeRow(
                  "lateFeeAmount",
                  "Late fee amount",
                  <MoneyInput
                    label="Late fee amount"
                    value={draft.lateFeeAmount ?? "50"}
                    onChange={(v) => patch({ lateFeeAmount: v }, "lateFeeAmount")}
                  />,
                )}
                {scopeRow(
                  "lateFeeGraceDays",
                  "Grace days",
                  <input
                    type="number"
                    min={0}
                    max={30}
                    className="h-9 w-20 rounded-lg border border-border bg-background px-2 text-[14px] font-semibold tabular-nums text-foreground"
                    value={draft.lateFeeGraceDays ?? 5}
                    onChange={(e) =>
                      patch({ lateFeeGraceDays: Number(e.target.value) || 0 }, "lateFeeGraceDays")
                    }
                    aria-label="Grace days"
                  />,
                )}
              </>
            ) : null}
          </>
        ),
      },
    ],
    [draft, showCoverageCode, workspacePayment],
  );

  return (
    <PortalPropertySectionSettingsModal
      open={open}
      onClose={onClose}
      title="Payment settings"
      propertyLabel={propertyLabel}
      onSave={save}
      dataAttr="property-pricing-settings"
    >
      <div className="space-y-5" data-ps40-page="payments-settings">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">{group.title}</p>
            <div className="divide-y divide-border rounded-xl border border-border bg-card">{group.rows}</div>
          </div>
        ))}
      </div>
    </PortalPropertySectionSettingsModal>
  );
}
