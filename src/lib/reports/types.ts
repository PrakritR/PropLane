export type ReportColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
  format?: "text" | "money" | "date" | "number";
};

export type ReportRow = Record<string, string | number | boolean | null>;

export type ReportResult = {
  id: string;
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportRow;
  meta?: Record<string, string | number | boolean | null>;
};

export type ReportDateRange = {
  from: string;
  to: string;
};

export type ManagerReportFilters = {
  propertyId?: string;
  from?: string;
  to?: string;
  daysAhead?: number;
  taxYear?: number;
  vendorId?: string;
  scope?: DocumentScope;
  residentEmail?: string;
  roomLabel?: string;
  /** Profitability report only: one row per property (default) or per property per month. */
  groupBy?: string;
};

export type DocumentScope = "portfolio" | "property" | "tenant" | "room";
export type FormalDocumentKind = "rent_receipt" | "days_rented" | "property_rent_receipt";

export type FormalDocumentFilters = ManagerReportFilters & {
  scope: DocumentScope;
  includeFields?: string[];
};

export type ResidentReportFilters = {
  from?: string;
  to?: string;
};

export const MANAGER_REPORT_IDS = [
  "tax-summary",
  "rent-receipts",
  "rental-days",
  "rent-roll",
  "delinquency",
  "income-statement",
  "expenses",
  "lease-expiration",
  "vendor-spend",
  "1099-candidates",
  "trial-balance",
  "balance-sheet",
  "general-ledger",
  "cash-flow-statement",
  "payout-history",
  "trust-account-balance",
  "financial-diagnostics",
  "ap-aging",
  "budget-vs-actual",
  "owner-statement",
  "profitability",
] as const;

export const RESIDENT_REPORT_IDS = ["resident-ledger"] as const;

export type ManagerReportId = (typeof MANAGER_REPORT_IDS)[number];
export type ResidentReportId = (typeof RESIDENT_REPORT_IDS)[number];
