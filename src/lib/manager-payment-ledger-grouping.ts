import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";

export type ManagerPaymentResidentCluster = {
  key: string;
  residentLabel: string;
  residentEmail?: string;
  /** Set when every charge in the cluster shares one property label. */
  propertyLabel: string | null;
  rows: DemoManagerPaymentLedgerRow[];
};

export function paymentLedgerResidentLabel(
  row: Pick<DemoManagerPaymentLedgerRow, "residentName" | "residentEmail">,
): string {
  const name = row.residentName?.trim();
  if (name) return name;
  const email = row.residentEmail?.trim();
  if (email?.includes("@")) return email;
  return "—";
}

export function residentPaymentLedgerGroupKey(
  row: Pick<DemoManagerPaymentLedgerRow, "id" | "residentEmail" | "residentName">,
): string {
  const email = row.residentEmail?.trim().toLowerCase();
  if (email?.includes("@")) return `email:${email}`;
  const name = row.residentName?.trim().toLowerCase();
  if (name) return `name:${name}`;
  return `id:${row.id}`;
}

function sharedPropertyLabel(rows: ReadonlyArray<DemoManagerPaymentLedgerRow>): string | null {
  if (rows.length === 0) return null;
  const first = rows[0]?.propertyName?.trim();
  if (!first) return null;
  return rows.every((row) => row.propertyName?.trim() === first) ? first : null;
}

/** Group ledger rows under one resident header, preserving the incoming sort order. */
export function clusterManagerPaymentLedgerRows(
  rows: DemoManagerPaymentLedgerRow[],
): ManagerPaymentResidentCluster[] {
  const out: ManagerPaymentResidentCluster[] = [];
  const byKey = new Map<string, ManagerPaymentResidentCluster>();

  for (const row of rows) {
    const key = residentPaymentLedgerGroupKey(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.propertyLabel = sharedPropertyLabel(existing.rows);
      continue;
    }

    const cluster: ManagerPaymentResidentCluster = {
      key,
      residentLabel: paymentLedgerResidentLabel(row),
      residentEmail: row.residentEmail?.trim() || undefined,
      propertyLabel: sharedPropertyLabel([row]),
      rows: [row],
    };
    byKey.set(key, cluster);
    out.push(cluster);
  }

  return out;
}
