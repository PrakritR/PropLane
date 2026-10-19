/**
 * Year-end tax package for a managed workspace's owner: Schedule E-ready totals per house and the vendors who may need a 1099.
 * Pure. It folds the same ledger lines the statement does, so the package and the statements can never disagree.
 */

import type { StatementLine } from "@/lib/managed-finance/statement";

export type TaxHouseRow = {
  propertyId: string;
  /** Schedule E line 3: rents received (gross, before PropLane's fee), net of refunds. */
  rentsReceivedCents: number;
  /** Management fees paid to PropLane (Schedule E line 14), net of fees returned on refunds. */
  managementFeesCents: number;
  /** Repairs and vendor charges deducted from the owner's balance. */
  repairsAndVendorsCents: number;
  netCents: number;
};

export type Tax1099Row = { partyId: string; name: string; totalCents: number; reportable: boolean };

export type TaxPackage = {
  year: number;
  houses: TaxHouseRow[];
  totals: { rentsReceivedCents: number; managementFeesCents: number; repairsAndVendorsCents: number; netCents: number };
  vendors: Tax1099Row[];
  /** Plain note for the owner: what is and is not in these figures. */
  basis: string;
};

export const FORM_1099_THRESHOLD_CENTS = 60_000;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

type ChargeDetail = { property_id?: string; owner_cents?: number; fee_cents?: number };

/** `ownerLines`: owner_payable lines; `vendorLines`: vendor_payable lines of vendor bills in the workspace, with their `partyId`. */
export function buildTaxPackage(
  year: number,
  ownerLines: readonly StatementLine[],
  vendorLines: ReadonlyArray<StatementLine & { partyId: string }>,
  vendorNames: ReadonlyMap<string, string>,
  defaultPropertyId = "",
): TaxPackage {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  const houses = new Map<string, TaxHouseRow>();
  const row = (id: string): TaxHouseRow => {
    const key = id || defaultPropertyId;
    let r = houses.get(key);
    if (!r) {
      r = { propertyId: key, rentsReceivedCents: 0, managementFeesCents: 0, repairsAndVendorsCents: 0, netCents: 0 };
      houses.set(key, r);
    }
    return r;
  };
  for (const line of ownerLines) {
    // The calendar year in Pacific time is what an owner files on; the ledger stores instants, compared as ISO strings.
    if (line.postedAt < start || line.postedAt >= end) continue;
    const d = line.detail;
    if (line.kind === "rent_capture") {
      const charges = Array.isArray(d.charges) ? (d.charges as ChargeDetail[]) : [];
      if (charges.length === 0) {
        const r = row("");
        r.rentsReceivedCents += num(d.owner_cents) + num(d.fee_cents);
        r.managementFeesCents += num(d.fee_cents);
      }
      for (const c of charges) {
        const r = row(String(c.property_id ?? ""));
        r.rentsReceivedCents += num(c.owner_cents) + num(c.fee_cents);
        r.managementFeesCents += num(c.fee_cents);
      }
    } else if (line.kind === "refund") {
      const r = row(String(d.property_id ?? ""));
      r.rentsReceivedCents -= num(d.owner_cents) + num(d.fee_cents);
      r.managementFeesCents -= num(d.fee_cents);
    } else if (line.kind === "vendor_bill") {
      row(String(d.property_id ?? "")).repairsAndVendorsCents += num(line.amountCents);
    }
  }
  const list = [...houses.values()].map((h) => ({ ...h, netCents: h.rentsReceivedCents - h.managementFeesCents - h.repairsAndVendorsCents }));
  const byVendor = new Map<string, number>();
  for (const line of vendorLines) {
    if (line.kind !== "vendor_bill" || line.postedAt < start || line.postedAt >= end) continue;
    byVendor.set(line.partyId, (byVendor.get(line.partyId) ?? 0) + -line.amountCents);
  }
  const vendors: Tax1099Row[] = [...byVendor.entries()]
    .map(([partyId, totalCents]) => ({ partyId, name: vendorNames.get(partyId) ?? "Vendor", totalCents, reportable: totalCents >= FORM_1099_THRESHOLD_CENTS }))
    .sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));
  const sum = (f: (h: TaxHouseRow) => number) => list.reduce((s, h) => s + f(h), 0);
  return {
    year,
    houses: list.sort((a, b) => a.propertyId.localeCompare(b.propertyId)),
    totals: {
      rentsReceivedCents: sum((h) => h.rentsReceivedCents),
      managementFeesCents: sum((h) => h.managementFeesCents),
      repairsAndVendorsCents: sum((h) => h.repairsAndVendorsCents),
      netCents: sum((h) => h.netCents),
    },
    vendors,
    basis: "Cash basis, from your PropLane ledger. Rents are before PropLane's fee. Mortgage interest, taxes, insurance and depreciation are not tracked here. PropLane does not give tax advice; share this with your preparer.",
  };
}

/** CSV for the preparer. Cells are quoted; no formulas can be injected from a vendor name. */
export function taxPackageCsv(pkg: TaxPackage, houseLabels: ReadonlyMap<string, string>): string {
  const cell = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const usd = (cents: number) => (cents / 100).toFixed(2);
  const lines = [
    ["House", "Rents received", "Management fees", "Repairs and vendors", "Net"].map(cell).join(","),
    ...pkg.houses.map((h) => [houseLabels.get(h.propertyId) ?? (h.propertyId || "Workspace"), usd(h.rentsReceivedCents), usd(h.managementFeesCents), usd(h.repairsAndVendorsCents), usd(h.netCents)].map(cell).join(",")),
    ["Total", usd(pkg.totals.rentsReceivedCents), usd(pkg.totals.managementFeesCents), usd(pkg.totals.repairsAndVendorsCents), usd(pkg.totals.netCents)].map(cell).join(","),
    "",
    ["Vendor", "Paid in year", "1099 threshold met"].map(cell).join(","),
    ...pkg.vendors.map((v) => [v.name, usd(v.totalCents), v.reportable ? "Yes" : "No"].map(cell).join(",")),
  ];
  return lines.join("\n") + "\n";
}
