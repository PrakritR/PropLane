/** Canonical fields for formal tax record PDFs (Schedule E recordkeeping). */

import { humanizeUnitLabel } from "@/lib/reports/display-context";

export type FormalFieldKey =
  | "receiptNumber"
  | "issueDate"
  | "landlordBlock"
  | "tenantBlock"
  | "propertyBlock"
  | "paymentDate"
  | "amount"
  | "paymentMethod"
  | "periodCovered"
  | "category"
  | "balanceAfter"
  | "daysRented"
  | "daysAvailable"
  | "personalUseNote";

export const RENT_RECEIPT_DEFAULT_FIELDS: FormalFieldKey[] = [
  "receiptNumber",
  "issueDate",
  "landlordBlock",
  "tenantBlock",
  "propertyBlock",
  "paymentDate",
  "amount",
  "paymentMethod",
  "periodCovered",
  "category",
  "daysRented",
  "daysAvailable",
  "balanceAfter",
];

export const PROPERTY_RENT_RECEIPT_DEFAULT_FIELDS: FormalFieldKey[] = [
  "issueDate",
  "landlordBlock",
  "propertyBlock",
  "daysRented",
  "daysAvailable",
  "amount",
  "periodCovered",
  "personalUseNote",
];

export const DAYS_RENTED_DEFAULT_FIELDS: FormalFieldKey[] = [
  "issueDate",
  "landlordBlock",
  "daysRented",
  "daysAvailable",
  "personalUseNote",
];

export const RENT_RECEIPT_FOOTER =
  "I certify that the above amount was received in full for the rental period described. This receipt serves as proof of payment and should be retained for tax, legal, and dispute-resolution purposes.";

export const DAYS_RENTED_FOOTER =
  "Days rented vs days available may be used for rental-use percentage calculations. Consult your tax advisor.";

export type RentReceiptDocument = {
  id: string;
  receiptNumber: string;
  issueDate: string;
  landlordName: string;
  landlordAddress: string;
  tenantName: string;
  tenantEmail: string;
  propertyLabel: string;
  unitLabel: string;
  propertyAddress: string;
  paymentDate: string;
  amount: string;
  processingFeeLabel?: string;
  totalChargedLabel?: string;
  paymentMethod: string;
  periodCovered: string;
  category: string;
  balanceAfter?: string;
  daysRented?: number;
  daysAvailable?: number;
};

export type PropertyRentReceiptUnitRow = {
  unit: string;
  resident: string;
  daysRented: number;
  daysAvailable: number;
  rentCollected: string;
  receiptCount: number;
};

export type IncomeCategoryRow = {
  categoryCode: string;
  label: string;
  scheduleERef: string;
  amountCents: number;
  amount: string;
};

export type PropertyRentReceiptDocument = {
  id: string;
  propertyId: string;
  propertyLabel: string;
  issueDate: string;
  periodFrom: string;
  periodTo: string;
  landlordName: string;
  landlordAddress: string;
  daysRented: number;
  daysAvailable: number;
  rentCollected: string;
  receiptCount: number;
  rentalUsePct: number;
  units: PropertyRentReceiptUnitRow[];
  incomeByCategory?: IncomeCategoryRow[];
  grossIncomeCents?: number;
};

export type DaysRentedRow = {
  property: string;
  unit: string;
  resident: string;
  residentEmail: string;
  leaseStart: string;
  leaseEnd: string;
  daysRented: number;
  daysAvailable: number;
};

export type DaysRentedDocument = {
  id: string;
  issueDate: string;
  scopeLabel: string;
  periodFrom: string;
  periodTo: string;
  landlordName: string;
  landlordAddress: string;
  rows: DaysRentedRow[];
  totalDaysRented: number;
  totalDaysAvailable: number;
  unitCount: number;
};

export type OccupancyUnitRow = {
  unit: string;
  resident: string;
  leaseStart: string;
  leaseEnd: string;
  daysRented: number;
  daysAvailable: number;
  occupancyPct: number;
  status: "occupied" | "vacant";
};

export type OccupancyPropertyGroup = {
  propertyId: string;
  propertyLabel: string;
  totalUnits: number;
  occupiedUnits: number;
  vacantUnits: number;
  daysRented: number;
  daysAvailable: number;
  occupancyPct: number;
  units: OccupancyUnitRow[];
};

export type OccupancyReport = {
  id: string;
  issueDate: string;
  periodFrom: string;
  periodTo: string;
  landlordName: string;
  landlordAddress: string;
  properties: OccupancyPropertyGroup[];
  portfolioOccupancyPct: number;
  totalUnits: number;
  occupiedUnits: number;
};

export function receiptNumberForLedgerEntry(ledgerId: string): string {
  return `RR-${ledgerId.slice(0, 8).toUpperCase()}`;
}

export function scopeLabel(
  scope: string,
  propertyLabel?: string,
  tenantLabel?: string,
  roomLabel?: string,
): string {
  if (scope === "property" && propertyLabel) return propertyLabel;
  if (scope === "tenant" && tenantLabel) return tenantLabel;
  if (scope === "room" && roomLabel) return humanizeUnitLabel(roomLabel) || roomLabel;
  return "All properties";
}

export function parseWorkOrderCategoryFromDescription(description: string): "cleaning" | "plumbing" | "mold" | "electrical" | "hvac" | "general" {
  const lower = description.toLowerCase();
  if (lower.startsWith("cleaning:") || lower.includes("cleaning")) return "cleaning";
  if (lower.startsWith("plumbing:") || lower.includes("plumbing")) return "plumbing";
  if (lower.startsWith("mold:") || lower.includes("mold")) return "mold";
  if (lower.startsWith("electrical:") || lower.includes("electrical")) return "electrical";
  if (lower.startsWith("hvac:") || lower.includes("hvac")) return "hvac";
  return "general";
}
