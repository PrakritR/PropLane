"use client";

import { useMemo, useState } from "react";
import { PortalPropertySectionSettingsModal } from "@/components/portal/portal-property-section-settings-modal";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MoneyInput } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ToggleRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  SERVICE_FEE_PAYER_OPTION_LABELS,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import {
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";

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
};

/**
 * Property Pricing gear — collecting, rent & late fees, and processing fee rows
 * (C2-PRC8 / C2-PS11 / C2-PR9).
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
}: Props) {
  const [draft, setDraft] = useState(() => normalizeManagerListingSubmissionV1(sub));

  const patch = (next: Partial<ManagerListingSubmissionV1>) => {
    setDraft((prev) => ({ ...prev, ...next }));
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

  const groups = useMemo(
    () => [
      {
        title: "Collecting",
        rows: (
          <>
            <SettingsRow label="Processing fee paid by">
              <FieldSingleSelect
                label="Processing fee paid by"
                options={PAYER_OPTIONS}
                value={draft.serviceFeePayer ?? "resident"}
                onChange={(v) => patch({ serviceFeePayer: v as ServiceFeePayer })}
                dataAttr="property-pricing-settings-fee-payer"
              />
            </SettingsRow>
            {showCoverageCode ? (
              <SettingsRow label="Coverage code">
                <input
                  className="h-9 w-full max-w-[220px] rounded-lg border border-border bg-background px-2 text-[14px] font-semibold text-foreground"
                  value={draft.serviceFeeWaiverCode ?? ""}
                  onChange={(e) => patch({ serviceFeeWaiverCode: e.target.value })}
                  data-attr="property-pricing-settings-coverage-code"
                  aria-label="Coverage code"
                />
              </SettingsRow>
            ) : null}
          </>
        ),
      },
      {
        title: "Rent & late fees",
        rows: (
          <>
            <SettingsRow label="Rent due">
              <FieldSingleSelect
                label="Rent due"
                options={DUE_DAY_OPTIONS}
                value={draft.rentDueDayMode ?? "first_of_month"}
                onChange={(v) => patch({ rentDueDayMode: v as "first_of_month" | "last_of_month" })}
                dataAttr="property-pricing-settings-due-day"
              />
            </SettingsRow>
            <SettingsRow label="Automatic late fees">
              <ToggleRow
                label="Automatic late fees"
                checked={draft.lateFeeEnabled !== false}
                onChange={(on) => patch({ lateFeeEnabled: on })}
                dataAttr="property-pricing-settings-late-on"
              />
            </SettingsRow>
            {draft.lateFeeEnabled !== false ? (
              <>
                <SettingsRow label="Late fee amount">
                  <MoneyInput
                    label="Late fee amount"
                    value={draft.lateFeeAmount ?? "50"}
                    onChange={(v) => patch({ lateFeeAmount: v })}
                  />
                </SettingsRow>
                <SettingsRow label="Grace days">
                  <input
                    type="number"
                    min={0}
                    max={30}
                    className="h-9 w-20 rounded-lg border border-border bg-background px-2 text-[14px] font-semibold tabular-nums text-foreground"
                    value={draft.lateFeeGraceDays ?? 5}
                    onChange={(e) => patch({ lateFeeGraceDays: Number(e.target.value) || 0 })}
                    aria-label="Grace days"
                  />
                </SettingsRow>
              </>
            ) : null}
          </>
        ),
      },
    ],
    [draft, showCoverageCode],
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

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-[14px] font-semibold text-foreground">{label}</span>
      <div className="min-w-0 sm:max-w-[55%] sm:text-right">{children}</div>
    </div>
  );
}
