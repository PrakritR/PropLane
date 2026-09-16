/**
 * Settings → Lease knobs that are not reminder rules (PLAN-0915 phase 2).
 * Stored beside `reminderRules` in `manager_automation_settings.row_data.leaseAutomation`.
 */
export type LeaseAutomationSettings = {
  /** Days after move-out by which the deposit accounting is due; drives the `deposit_accounting` reminder's deadline. */
  depositAccountingDays: 14 | 21 | 30;
};

export const DEFAULT_LEASE_AUTOMATION_SETTINGS: LeaseAutomationSettings = { depositAccountingDays: 21 };

export const DEPOSIT_ACCOUNTING_OPTIONS: { value: LeaseAutomationSettings["depositAccountingDays"]; label: string }[] = [
  { value: 21, label: "21 days after move-out" },
  { value: 14, label: "14 days after move-out" },
  { value: 30, label: "30 days after move-out" },
];

export function normalizeLeaseAutomationSettings(raw: unknown): LeaseAutomationSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const days = row.depositAccountingDays;
  return { depositAccountingDays: days === 14 || days === 21 || days === 30 ? days : DEFAULT_LEASE_AUTOMATION_SETTINGS.depositAccountingDays };
}
