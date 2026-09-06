import { z } from "zod";

/** Source cells are evidence, never executable instructions. No access codes in this model. */
export const migrationDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a real calendar date");
const key = z.string().trim().min(1).max(200);
const cents = z.number().int().nonnegative().max(1_000_000_000);
const sheetName = z.string().min(1).max(200); // Google Sheets titles may have significant trailing spaces.
export const sourceSchema = z.object({ sheet: sheetName, range: key, recordKey: key }).strict();
export const tenancySchema = z.object({
  source: sourceSchema,
  /** Stable identity of THIS stay, not a row number or room number. */
  tenancyKey: key,
  roomId: key,
  name: key,
  email: z.string().email().max(254),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  start: migrationDate,
  end: migrationDate.nullable(),
  monthToMonth: z.boolean(),
  monthlyRentCents: cents,
  fixedUtilitiesCents: cents.optional(),
  /** Explicit match to an existing application, after owner/room/identity validation. */
  existingApplicationId: key.optional(),
}).strict().superRefine((stay, ctx) => {
  if (!stay.end && !stay.monthToMonth) ctx.addIssue({ code: "custom", message: "Confirm end date or month-to-month", path: ["end"] });
  if (stay.end && (stay.end < stay.start || stay.monthToMonth)) ctx.addIssue({ code: "custom", message: "Inconsistent tenancy dates", path: ["end"] });
});

export const financialFactSchema = z.object({
  source: sourceSchema,
  kind: z.enum(["opening_balance", "payment", "deposit_held", "deposit_refund", "deposit_deduction", "income", "expense"]),
  tenancyKey: key.optional(),
  date: migrationDate,
  amountCents: cents.refine(value => value > 0, "Amount must be positive"),
  categoryCode: key,
  description: key,
  /** Refunds/deductions refer to a separately reviewed deposit-held source record. */
  depositRecordKey: key.optional(),
  /** A payment and a separate opening balance must not represent the same unpaid amount. */
  chargeKind: z.enum(["rent", "utilities", "move_in_fee", "other_cost"]).optional(),
}).strict().superRefine((fact, ctx) => {
  if (["opening_balance", "payment"].includes(fact.kind) && !fact.chargeKind) ctx.addIssue({ code: "custom", message: "Select the historical charge kind", path: ["chargeKind"] });
  if (!["income", "expense"].includes(fact.kind) && !fact.tenancyKey) ctx.addIssue({ code: "custom", message: "Resident history requires a tenancy identity", path: ["tenancyKey"] });
  if (["deposit_refund", "deposit_deduction"].includes(fact.kind) && !fact.depositRecordKey) ctx.addIssue({ code: "custom", message: "Select the source deposit", path: ["depositRecordKey"] });
});

export const salesMigrationSchema = z.object({
  version: z.literal(2),
  workbookId: key,
  asOf: migrationDate,
  /** Required independent physical inventory, including rooms absent from a roster. */
  inventory: z.array(z.object({ propertyKey: key, roomCount: z.number().int().min(1).max(500) }).strict()).min(1).max(100),
  properties: z.array(z.object({
    propertyKey: key,
    propertyId: key,
    sheet: sheetName,
    rooms: z.array(z.object({ roomId: key, roomNumber: z.number().int().positive() }).strict()).min(1).max(500),
    tenancies: z.array(tenancySchema).max(500),
    facts: z.array(financialFactSchema).max(5000),
    /** Totals are checks only. Never insert them as another transaction. */
    checks: z.array(z.object({
      source: sourceSchema, kind: z.enum(["income", "expense", "deposit_held", "opening_balance", "payment", "deposit_refund", "deposit_deduction"]),
      start: migrationDate, end: migrationDate, expectedCents: cents,
    }).strict()).max(500),
  }).strict()).min(1).max(100),
  unresolved: z.array(z.object({ source: sourceSchema, propertyKey: key, roomNumber: z.number().int().positive().optional(), reason: key }).strict()).max(1000),
}).strict();

export type SalesMigration = z.infer<typeof salesMigrationSchema>;
export type MigrationTenancy = z.infer<typeof tenancySchema>;
export type FinancialFact = z.infer<typeof financialFactSchema>;

export const SALES_CONFIRMED_INVENTORY = [
  { propertyKey: "4709A", sheet: "Seattle 8Th Ave", roomCount: 10 },
  { propertyKey: "5259", sheet: "Seattle 5259Brooklyn ", roomCount: 9 },
  { propertyKey: "5257", sheet: "Seattle 5257Brooklyn", roomCount: 9 },
] as const;

export function validateMigration(raw: unknown): SalesMigration {
  const plan = salesMigrationSchema.parse(raw);
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
  };
  unique(plan.inventory.map(p => p.propertyKey), "inventory property");
  unique(plan.properties.map(p => p.propertyKey), "property mapping");
  unique(plan.properties.map(p => p.propertyId), "canonical property");
  if (plan.properties.length !== plan.inventory.length) throw new Error("Map every inventory property");
  if (plan.workbookId === "11FJ3Ugv4CjhJtUk18DU2-CaM6UJQJjSwQ_bzDU-ThJw") {
    for (const confirmed of SALES_CONFIRMED_INVENTORY) {
      if (plan.inventory.find(p => p.propertyKey === confirmed.propertyKey)?.roomCount !== confirmed.roomCount) throw new Error(`Confirmed inventory requires ${confirmed.propertyKey}: ${confirmed.roomCount} rooms`);
      if (plan.properties.find(p => p.propertyKey === confirmed.propertyKey)?.sheet !== confirmed.sheet) throw new Error(`Check sheet mapping for ${confirmed.propertyKey}`);
    }
  }
  for (const property of plan.properties) {
    const count = plan.inventory.find(p => p.propertyKey === property.propertyKey)?.roomCount;
    if (property.rooms.length !== count) throw new Error(`Physical room count does not reconcile: ${property.propertyKey}`);
    unique(property.rooms.map(r => r.roomId), "room id");
    unique(property.rooms.map(r => String(r.roomNumber)), "physical room number");
    if (property.rooms.some(r => r.roomNumber > count!)) throw new Error("Room number exceeds inventory");
    unique(property.tenancies.map(t => t.tenancyKey), "tenancy identity");
    unique(property.facts.map(f => f.source.recordKey), "financial source record");
    const rooms = new Set(property.rooms.map(r => r.roomId));
    for (const stay of property.tenancies) if (!rooms.has(stay.roomId)) throw new Error("Tenancy has no mapped physical room");
    for (const fact of property.facts) {
      if (fact.date > plan.asOf) throw new Error("Historical fact is after migration cutover");
      if (fact.tenancyKey && !property.tenancies.some(t => t.tenancyKey === fact.tenancyKey)) throw new Error("Financial fact has no resolved tenancy");
      if (fact.depositRecordKey) {
        const deposit = property.facts.find(f => f.source.recordKey === fact.depositRecordKey);
        if (!deposit || deposit.kind !== "deposit_held" || deposit.tenancyKey !== fact.tenancyKey || deposit.date > fact.date) throw new Error("Deposit adjustment has no matching earlier receipt");
      }
    }
    for (const deposit of property.facts.filter(f => f.kind === "deposit_held")) {
      const disposed = property.facts.filter(f => f.depositRecordKey === deposit.source.recordKey).reduce((sum, f) => sum + f.amountCents, 0);
      if (disposed > deposit.amountCents) throw new Error("Deposit adjustments exceed the original deposit");
    }
    for (const check of property.checks) {
      const total = property.facts.filter(f => f.kind === check.kind && f.date >= check.start && f.date <= check.end).reduce((sum, f) => sum + f.amountCents, 0);
      if (check.end < check.start || total !== check.expectedCents) throw new Error(`Source total does not reconcile: ${property.propertyKey} ${check.source.range}`);
    }
  }
  return plan;
}
