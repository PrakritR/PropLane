import { prepareSalesFinancialBlock, type SalesFinancialBlock } from "./financial-source";
import { readSalesWorkbookRoster } from "@/lib/sales-workbook-roster";
import { SALES_CONFIRMED_INVENTORY, tenancySchema, type SalesMigration } from "./model";

export type SalesPropertyMapping = { propertyKey: string; propertyId: string; rooms: { roomId: string; roomNumber: number }[] };
/** Builds a review draft from current rosters only. Adjacent P&L/deposit blocks are never joined to room rows. */
export function prepareSalesWorkbookMigration(input: {
  workbookId: string; asOf: string;
  sheets: { title: string; rows: unknown[][] }[];
  mappings: SalesPropertyMapping[];
  financialBlocks?: SalesFinancialBlock[];
}): SalesMigration {
  const plan: SalesMigration = { version: 2, workbookId: input.workbookId, asOf: input.asOf,
    inventory: SALES_CONFIRMED_INVENTORY.map(({ propertyKey, roomCount }) => ({ propertyKey, roomCount })), properties: [], unresolved: [] };
  for (const confirmed of SALES_CONFIRMED_INVENTORY) {
    const mapping = input.mappings.find(m => m.propertyKey === confirmed.propertyKey);
    if (!mapping) throw new Error(`Canonical mapping required for ${confirmed.propertyKey}`);
    const sheet = input.sheets.find(s => s.title === confirmed.sheet);
    if (!sheet) throw new Error(`Read the bounded roster range for ${confirmed.sheet}`);
    const parsed = readSalesWorkbookRoster(sheet.rows.map(row => row.map(cell => String(cell ?? ""))));
    const property: SalesMigration["properties"][number] = { ...mapping, sheet: confirmed.sheet, tenancies: [], facts: [], checks: [] };
    const flag = (roomNumber: number | undefined, range: string, reason: string) => plan.unresolved.push({ propertyKey: confirmed.propertyKey, roomNumber, source: { sheet: confirmed.sheet, range, recordKey: `review:${roomNumber ?? "property"}:${plan.unresolved.length}` }, reason });
    for (const physical of mapping.rooms) {
      const matches = parsed.rooms.filter(room => room.roomNumber === physical.roomNumber);
      if (matches.length !== 1) { flag(physical.roomNumber, "current-roster", "Room missing or duplicated in current roster; occupancy and terms remain unknown"); continue; }
      const room = matches[0]!;
      if (room.occupancy === "vacant") continue;
      if (room.occupancy === "short-term") { flag(physical.roomNumber, "current-roster", "Reconcile dated channel bookings; no long-term debtor is inferred"); continue; }
      const source = { sheet: confirmed.sheet, range: `A${room.sourceRow}:AZ${room.sourceRow}`, recordKey: `${confirmed.propertyKey}:${room.room}:${room.leaseStartIso}` };
      const result = tenancySchema.safeParse({ source, tenancyKey: `${physical.roomId}:${room.residentEmail.trim().toLowerCase()}:${room.leaseStartIso}`, roomId: physical.roomId, name: room.residentName, email: room.residentEmail, ...(room.residentPhone ? { phone: room.residentPhone } : {}), start: room.leaseStartIso, end: room.leaseEndIso || null, monthToMonth: room.monthToMonth, monthlyRentCents: room.monthlyRent == null ? null : Math.round(room.monthlyRent * 100), ...(room.monthlyUtilities == null ? {} : { fixedUtilitiesCents: Math.round(room.monthlyUtilities * 100) }) });
      if (result.success) property.tenancies.push(result.data);
      else for (const issue of result.error.issues) flag(physical.roomNumber, source.range, `${issue.path.join(".")}: ${issue.message}`.slice(0, 200));
      if (room.depositHeld != null) flag(physical.roomNumber, source.range, "Confirm deposit receipt date, original amount and prior dispositions; held money is not a new balance due");
    }
    for (const issue of parsed.issues) flag(undefined, "current-roster", `${issue.room}: ${issue.field}: ${issue.reason}`.slice(0, 200));
    for (const block of input.financialBlocks?.filter(b => b.propertyKey === confirmed.propertyKey) ?? []) {
      const mapped = prepareSalesFinancialBlock(block);
      property.facts.push(...mapped.facts);
      plan.unresolved.push(...mapped.unresolved);
    }
    flag(undefined, "property-accounts", "Map dated financial transactions and reconcile totals before enabling billing");
    plan.properties.push(property);
  }
  return plan;
}
