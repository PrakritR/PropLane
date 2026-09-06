import { z } from "zod";
import { defineTool, defineWriteTool, type ActionPreview } from "../registry";
import type { AgentContext } from "../context";
import type { ManagerReportFilters, ReportResult } from "@/lib/reports/types";
import { assertFinancialsTier } from "@/lib/reports/auth";
import { chartAccountLabel, chartAccountScheduleE } from "@/lib/reports/categories";
import {
  MANUAL_EXPENSE_CODES,
  MANUAL_INCOME_CODES,
  recordManualExpense,
  recordManualIncome,
} from "@/lib/reports/manual-entries.server";
import { centsToUsd, dollarsToCents } from "@/lib/reports/money";
import {
  queryRentRoll,
  queryDelinquency,
  queryIncomeStatement,
  queryExpenses,
  queryRentReceipts,
  queryRentalDays,
  queryTaxSummary,
  queryLeaseExpiration,
  queryVendorSpend,
} from "@/lib/reports/queries";
import { writeAuditLog, updateAuditResult } from "../audit";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";

/**
 * Financial reports the agent may run. The numbers are computed by these query
 * functions from the landlord's own ledger/charges — the model never computes a
 * figure itself. The `1099_candidates` report is intentionally NOT exposed
 * because it reads vendor W-9 / TIN data (`vendor_tax_profiles`); tax identifiers
 * must never reach the model.
 */
const REPORTS = {
  rent_roll: queryRentRoll,
  delinquency: queryDelinquency,
  income_statement: queryIncomeStatement,
  expenses: queryExpenses,
  rent_receipts: queryRentReceipts,
  rental_days: queryRentalDays,
  tax_summary: queryTaxSummary,
  lease_expiration: queryLeaseExpiration,
  vendor_spend: queryVendorSpend,
} as const satisfies Record<
  string,
  (db: AgentContext["db"], managerUserId: string, filters: ManagerReportFilters) => Promise<ReportResult>
>;

export type FinancialReportName = keyof typeof REPORTS;

export const runFinancialReportTool = defineTool({
  name: "run_financial_report",
  description:
    "Run a financial report over the current landlord's books and return its computed columns, rows, and totals. Reports: rent_roll (current rent + deposits per resident), delinquency (who is behind and by how much), income_statement, expenses, rent_receipts, rental_days, tax_summary (Schedule E style category totals), lease_expiration (upcoming lease ends), vendor_spend (spend per vendor). All figures come from this tool; never compute or estimate them yourself.",
  kind: "read",
  inputSchema: z
    .object({
      report: z
        .enum(
          Object.keys(REPORTS) as [FinancialReportName, ...FinancialReportName[]],
        )
        .describe("Which financial report to run."),
      propertyId: z.string().optional().describe("Optional: limit to a single property id."),
      from: z.string().optional().describe("Optional ISO date (YYYY-MM-DD) range start."),
      to: z.string().optional().describe("Optional ISO date (YYYY-MM-DD) range end."),
      taxYear: z.number().int().optional().describe("Optional tax year for tax_summary."),
      vendorId: z.string().optional().describe("Optional vendor id for vendor_spend."),
      daysAhead: z.number().int().optional().describe("Optional window for lease_expiration."),
    })
    .strict(),
  handler: async (ctx, input): Promise<ReportResult> => {
    const run = REPORTS[input.report];
    const filters: ManagerReportFilters = {
      propertyId: input.propertyId,
      from: input.from,
      to: input.to,
      taxYear: input.taxYear,
      vendorId: input.vendorId,
      daysAhead: input.daysAhead,
    };
    return run(ctx.db, ctx.landlordId, filters);
  },
});

/** Stable short FNV-1a hash of normalized text, for dedupe-key components. */
function hashText(text: string): string {
  const s = text.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

type OwnedLabel = { ok: true; label: string } | { ok: false; error: string };

/** Resolve a property id against the landlord's OWN records; returns a display label. */
async function resolveOwnedPropertyLabel(ctx: AgentContext, propertyId: string): Promise<OwnedLabel> {
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", ctx.landlordId)
    .eq("id", propertyId)
    .limit(1);
  if (error) throw new Error(error.message);
  const rec = (data ?? [])[0] as { id: string; row_data: unknown; property_data: unknown } | undefined;
  if (!rec) {
    return {
      ok: false,
      error: `Property ${propertyId} is not one of this landlord's properties. Use list_properties or find_records to get a valid property id.`,
    };
  }
  const src = (rec.property_data ?? rec.row_data ?? {}) as Record<string, unknown>;
  const label = [src.title, src.buildingName, src.name, src.address].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return { ok: true, label: label?.trim() ?? rec.id };
}

/** Resolve a vendor id against the landlord's OWN vendor records; returns the vendor name. */
async function resolveOwnedVendorLabel(ctx: AgentContext, vendorId: string): Promise<OwnedLabel> {
  const { data, error } = await ctx.db
    .from("manager_vendor_records")
    .select("id, row_data")
    .eq("manager_user_id", ctx.landlordId)
    .eq("id", vendorId)
    .limit(1);
  if (error) throw new Error(error.message);
  const rec = (data ?? [])[0] as { id: string; row_data: unknown } | undefined;
  if (!rec) {
    return {
      ok: false,
      error: `Vendor ${vendorId} is not one of this landlord's vendors. Use list_vendors or find_records to get a valid vendor id.`,
    };
  }
  const row = (rec.row_data ?? {}) as { name?: unknown };
  return { ok: true, label: typeof row.name === "string" && row.name.trim() ? row.name.trim() : rec.id };
}

type ManualEntryKind = "expense" | "income";

const MANUAL_ENTRY_META: Record<
  ManualEntryKind,
  { toolName: string; noun: string; codes: Set<string>; defaultScheduleE: string }
> = {
  expense: {
    toolName: "record_expense",
    noun: "expense",
    codes: MANUAL_EXPENSE_CODES,
    defaultScheduleE: "Sch. E, Line 19",
  },
  income: {
    toolName: "record_income",
    noun: "income",
    codes: MANUAL_INCOME_CODES,
    defaultScheduleE: "Sch. E, Line 3",
  },
};

type ManualEntryInput = {
  amountUsd: number;
  categoryCode: string;
  postedDate: string;
  description?: string;
  propertyId?: string;
  vendorId?: string;
  residentEmail?: string;
};

type ResolvedManualEntry = {
  amountCents: number;
  categoryLabel: string;
  scheduleERef: string;
  propertyLabel: string | null;
  vendorLabel: string | null;
};

/**
 * Shared read-only validation for both manual-entry tools: subscription tier
 * gate, known category code, and ownership of any referenced property/vendor.
 */
async function resolveManualEntry(
  ctx: AgentContext,
  kind: ManualEntryKind,
  input: ManualEntryInput,
): Promise<{ ok: true; resolved: ResolvedManualEntry } | { ok: false; error: string }> {
  const meta = MANUAL_ENTRY_META[kind];
  const gate = await assertFinancialsTier(ctx.landlordId);
  if (!gate.ok) return { ok: false, error: gate.error };

  const categoryCode = input.categoryCode.trim();
  if (!meta.codes.has(categoryCode)) {
    return {
      ok: false,
      error: `Unknown ${meta.noun} category code "${categoryCode}". Valid codes: ${[...meta.codes].join(", ")}.`,
    };
  }

  let propertyLabel: string | null = null;
  if (input.propertyId?.trim()) {
    const property = await resolveOwnedPropertyLabel(ctx, input.propertyId.trim());
    if (!property.ok) return property;
    propertyLabel = property.label;
  }

  let vendorLabel: string | null = null;
  if (input.vendorId?.trim()) {
    const vendor = await resolveOwnedVendorLabel(ctx, input.vendorId.trim());
    if (!vendor.ok) return vendor;
    vendorLabel = vendor.label;
  }

  return {
    ok: true,
    resolved: {
      amountCents: dollarsToCents(input.amountUsd),
      categoryLabel: chartAccountLabel(categoryCode),
      scheduleERef: chartAccountScheduleE(categoryCode)?.ref ?? meta.defaultScheduleE,
      propertyLabel,
      vendorLabel,
    },
  };
}

function withResolvedPostedDate(input: Omit<ManualEntryInput, "postedDate"> & { postedDate?: string }): ManualEntryInput {
  const postedDate = input.postedDate?.trim();
  return {
    ...input,
    postedDate: postedDate && /^\d{4}-\d{2}-\d{2}$/.test(postedDate) ? postedDate : pacificCalendarDateYmd(),
  };
}

function postedDateYearWarning(postedDate: string): string | undefined {
  const currentYear = pacificCalendarDateYmd().slice(0, 4);
  const postedYear = postedDate.slice(0, 4);
  if (postedYear === currentYear) return undefined;
  return `This date is in ${postedYear}, not ${currentYear}. Confirm only if that year is intentional.`;
}

function manualEntryPreview(
  kind: ManualEntryKind,
  input: ManualEntryInput,
  resolved: ResolvedManualEntry,
): ActionPreview {
  const meta = MANUAL_ENTRY_META[kind];
  const lines = [
    { label: "Amount", value: centsToUsd(resolved.amountCents) },
    { label: "Category", value: resolved.categoryLabel },
    { label: "Schedule E", value: resolved.scheduleERef },
    { label: "Date", value: input.postedDate },
  ];
  if (resolved.propertyLabel) lines.push({ label: "Property", value: resolved.propertyLabel });
  if (resolved.vendorLabel) lines.push({ label: "Vendor", value: resolved.vendorLabel });
  if (input.residentEmail?.trim()) {
    lines.push({ label: "Resident", value: input.residentEmail.trim().toLowerCase() });
  }
  if (input.description?.trim()) lines.push({ label: "Description", value: input.description.trim() });
  const yearWarning = postedDateYearWarning(input.postedDate);
  return {
    kind: meta.toolName,
    title: kind === "expense" ? "Record expense" : "Record income",
    summary: `Record a ${centsToUsd(resolved.amountCents)} ${resolved.categoryLabel} ${meta.noun} entry dated ${input.postedDate}${resolved.propertyLabel ? ` for ${resolved.propertyLabel}` : ""}.`,
    fields: lines,
    warnings: yearWarning ? [yearWarning] : undefined,
    confirmLabel: kind === "expense" ? "Record expense" : "Record income",
  };
}

/**
 * Shared executor for both manual-entry tools: re-validates everything against
 * live landlord-scoped data, records intent in audit_log FIRST (idempotent on
 * amount+category+date+description), then books the entry via the same
 * manual-entries lib the /api/income and /api/expenses routes use.
 */
async function executeManualEntry(ctx: AgentContext, kind: ManualEntryKind, rawInput: Omit<ManualEntryInput, "postedDate"> & { postedDate?: string }) {
  const meta = MANUAL_ENTRY_META[kind];
  const input = withResolvedPostedDate(rawInput);
  const check = await resolveManualEntry(ctx, kind, input);
  if (!check.ok) throw new Error(check.error);
  const { resolved } = check;
  const categoryCode = input.categoryCode.trim();

  const dedupeKey = `${meta.toolName}:${ctx.landlordId}:${resolved.amountCents}:${categoryCode}:${input.postedDate}:${hashText(input.description ?? "")}`;
  const audit = await writeAuditLog(ctx, {
    action: meta.toolName,
    toolName: meta.toolName,
    inputSummary: {
      amountCents: resolved.amountCents,
      categoryCode,
      postedDate: input.postedDate,
      propertyId: input.propertyId?.trim() || null,
      vendorId: input.vendorId?.trim() || null,
    },
    dedupeKey,
  });
  if (!audit.recorded) {
    if (audit.duplicate) {
      return {
        reply: `An identical ${meta.noun} entry (same amount, category, date, and description) was already recorded — nothing new was added.`,
        resultSummary: { alreadyRecorded: true },
      };
    }
    throw new Error(`Could not record the action; the ${meta.noun} was not booked.`);
  }

  const result =
    kind === "expense"
      ? await recordManualExpense(ctx.db, ctx.landlordId, {
          propertyId: input.propertyId?.trim() || null,
          categoryCode,
          amountCents: resolved.amountCents,
          expenseDate: input.postedDate,
          memo: input.description?.trim() || null,
          vendorId: input.vendorId?.trim() || null,
        })
      : await recordManualIncome(ctx.db, ctx.landlordId, {
          propertyId: input.propertyId?.trim() || null,
          categoryCode,
          amountCents: resolved.amountCents,
          postedDate: input.postedDate,
          description: input.description?.trim() || null,
          residentEmail: input.residentEmail?.trim() || null,
        });

  if (!result.ok) {
    // Clear the dedupe key so a retry can record a fresh attempt instead of
    // short-circuiting to "already recorded" for an entry that never booked.
    await updateAuditResult(ctx, dedupeKey, { booked: false }, { clearDedupeKey: true });
    throw new Error(result.error);
  }

  const entryId = typeof result.entry.id === "string" || typeof result.entry.id === "number" ? String(result.entry.id) : null;
  await updateAuditResult(ctx, dedupeKey, { booked: true, entryId });
  return {
    reply: `Recorded a ${centsToUsd(resolved.amountCents)} ${resolved.categoryLabel} ${meta.noun} entry dated ${input.postedDate}${resolved.propertyLabel ? ` for ${resolved.propertyLabel}` : ""}.`,
    resultSummary: { entryId, amountCents: resolved.amountCents, categoryCode },
  };
}

const POSTED_DATE_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)")
  .describe(
    "Optional ISO date YYYY-MM-DD. Omit to use today's Pacific date. Use the current year unless the manager names another year.",
  );

export const recordExpenseTool = defineWriteTool({
  name: "record_expense",
  description:
    "Record a manual expense entry in the landlord's books (same bookkeeping as the Financials page). Requires an expense category code; get propertyId from list_properties/find_records and vendorId from list_vendors/find_records when the expense should be attributed to one. Use today's Pacific date unless the manager names a different date.",
  inputSchema: z
    .object({
      amountUsd: z.number().positive().describe("Expense amount in US dollars, e.g. 125.5 for $125.50."),
      categoryCode: z
        .string()
        .min(1)
        .describe("Expense category code from the chart of accounts, e.g. 'maintenance', 'plumbing', 'utilities', 'insurance'."),
      postedDate: POSTED_DATE_SCHEMA.optional(),
      description: z.string().optional().describe("Optional memo describing the expense."),
      propertyId: z.string().optional().describe("Optional property id (from list_properties) to attribute the expense to."),
      vendorId: z.string().optional().describe("Optional vendor id (from list_vendors) the expense was paid to."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const resolvedInput = withResolvedPostedDate(input);
    const check = await resolveManualEntry(ctx, "expense", resolvedInput);
    if (!check.ok) throw new Error(check.error);
    return { ...manualEntryPreview("expense", resolvedInput, check.resolved), confirmedInput: resolvedInput };
  },
  handler: (ctx, input) => executeManualEntry(ctx, "expense", input),
});

export const recordIncomeTool = defineWriteTool({
  name: "record_income",
  description:
    "Record a manual income entry in the landlord's books (rent collected outside Axis, fees, other income — same bookkeeping as the Financials page). Requires an income category code; get propertyId from list_properties/find_records when the income belongs to a property. Use today's Pacific date unless the manager names a different date.",
  inputSchema: z
    .object({
      amountUsd: z.number().positive().describe("Income amount in US dollars, e.g. 1500 for $1,500.00."),
      categoryCode: z
        .string()
        .min(1)
        .describe("Income category code from the chart of accounts, e.g. 'rent_income', 'late_fees', 'other_income'."),
      postedDate: POSTED_DATE_SCHEMA.optional(),
      description: z.string().optional().describe("Optional description of the income entry."),
      propertyId: z.string().optional().describe("Optional property id (from list_properties) to attribute the income to."),
      residentEmail: z.string().optional().describe("Optional resident email the income was received from."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const resolvedInput = withResolvedPostedDate(input);
    const check = await resolveManualEntry(ctx, "income", resolvedInput);
    if (!check.ok) throw new Error(check.error);
    return { ...manualEntryPreview("income", resolvedInput, check.resolved), confirmedInput: resolvedInput };
  },
  handler: (ctx, input) => executeManualEntry(ctx, "income", input),
});
