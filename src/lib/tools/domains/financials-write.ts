/**
 * Gated manager-financials WRITE tools (plan §7). These are `kind: "write"`, so
 * `runReadTool` refuses them — the model loop can only ever build their
 * `preview`, and the handler runs later from the confirm endpoint with the
 * server-stored input, per the AGENTS.md write-gating contract. Every handler
 * scopes to `ctx.landlordId` (the authenticated manager), never model input, so
 * cross-landlord writes are structurally impossible. All figures are computed
 * server-side from stored data — the model never supplies a balance or split.
 *
 * Every tool here carries a `preview` so it can live in the model-visible
 * `agentRegistry`: without one, `previewWriteTool` rejects the call and the
 * capability is unreachable from the assistant no matter what the model asks.
 */
import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { ActionPreview } from "../registry";
import type { AgentContext } from "../context";
import {
  approveManagerBill,
  createManagerBill,
  payManagerBill,
} from "@/lib/manager-bills.server";
import { upsertManagerBudget } from "@/lib/manager-budgets.server";
import {
  approveOwnerDistribution,
  createOwnerDistribution,
} from "@/lib/manager-owner-distributions.server";
import { reconcileBankStatementLine } from "@/lib/manager-bank-reconciliation.server";
import { computeDispositionSplit, disposeSecurityDeposit, getSecurityDepositById } from "@/lib/reports/security-deposits";

/** Integer cents → the dollar string the landlord reads on the confirmation card. */
function money(cents: number | null | undefined): string {
  const n = Math.round(Number(cents ?? 0));
  return `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Read one of the landlord's own rows for a preview. The `manager_user_id`
 * filter is not optional: a preview that skipped it would render another
 * landlord's record onto this landlord's confirmation card.
 */
async function loadOwnedRow(
  ctx: AgentContext,
  table: string,
  columns: string,
  id: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await ctx.db
    .from(table)
    .select(columns)
    .eq("manager_user_id", ctx.landlordId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That record isn't in your portfolio.");
  return data as unknown as Record<string, unknown>;
}

export const createManagerBillTool = defineWriteTool({
  name: "create_manager_bill",
  description:
    "Create a new accounts-payable bill (an unpaid obligation owed to a vendor). Amounts are integer cents. Requires explicit user confirmation. The bill starts in pending_approval and does NOT post an expense until it is paid.",
  inputSchema: z
    .object({
      description: z.string().min(1),
      amountCents: z.number().int().positive(),
      dueDate: z.string().optional().describe("ISO date YYYY-MM-DD."),
      vendorId: z.string().optional(),
      workOrderId: z.string().optional(),
      propertyId: z.string().optional(),
      categoryCode: z.string().optional(),
    })
    .strict(),
  preview: async (_ctx, input): Promise<ActionPreview> => ({
    kind: "create_manager_bill",
    title: "Create this bill",
    confirmLabel: "Create bill",
    fields: [
      { label: "Description", value: input.description },
      { label: "Amount", value: money(input.amountCents) },
      ...(input.dueDate ? [{ label: "Due", value: input.dueDate }] : []),
      ...(input.categoryCode ? [{ label: "Category", value: input.categoryCode }] : []),
    ],
    warnings: ["The bill starts pending approval; no expense posts until it is paid."],
  }),
  handler: async (ctx: AgentContext, input) =>
    createManagerBill(ctx.db, {
      managerUserId: ctx.landlordId,
      description: input.description,
      amountCents: input.amountCents,
      dueDate: input.dueDate,
      vendorId: input.vendorId,
      workOrderId: input.workOrderId,
      propertyId: input.propertyId,
      categoryCode: input.categoryCode,
    }),
});

/** Bill fields both bill previews resolve from the landlord's own row. */
async function previewBill(
  ctx: AgentContext,
  billId: string,
): Promise<{ description: string; amountCents: number; status: string }> {
  const row = await loadOwnedRow(
    ctx,
    "manager_bills",
    "id, description, amount_cents, status, due_date",
    billId,
  );
  return {
    description: String(row.description ?? "(no description)"),
    amountCents: Number(row.amount_cents ?? 0),
    status: String(row.status ?? "unknown"),
  };
}

export const approveManagerBillTool = defineWriteTool({
  name: "approve_manager_bill",
  description:
    "Approve a pending accounts-payable bill so it can be paid. Posts a GL entry (DR expense / CR accounts payable). Use run_financial_report with report 'ap_aging' or 'bills' data to find the bill id. Requires explicit user confirmation.",
  inputSchema: z.object({ billId: z.string().min(1) }).strict(),
  preview: async (ctx, input): Promise<ActionPreview> => {
    const bill = await previewBill(ctx, input.billId);
    return {
      kind: "approve_manager_bill",
      title: "Approve this bill",
      confirmLabel: "Approve bill",
      fields: [
        { label: "Bill", value: bill.description },
        { label: "Amount", value: money(bill.amountCents) },
        { label: "Current status", value: bill.status },
      ],
      warnings: ["Approving posts an expense and accounts-payable entry to the general ledger."],
    };
  },
  handler: async (ctx: AgentContext, input) =>
    approveManagerBill(ctx.db, ctx.landlordId, input.billId, ctx.userId),
});

export const recordBillPaymentTool = defineWriteTool({
  name: "record_bill_payment",
  description:
    "Mark an approved accounts-payable bill as paid: creates the expense entry and posts the cash-out GL entry (DR accounts payable / CR operating cash). Requires explicit user confirmation.",
  inputSchema: z.object({ billId: z.string().min(1) }).strict(),
  preview: async (ctx, input): Promise<ActionPreview> => {
    const bill = await previewBill(ctx, input.billId);
    return {
      kind: "record_bill_payment",
      title: "Record payment for this bill",
      confirmLabel: "Mark paid",
      fields: [
        { label: "Bill", value: bill.description },
        { label: "Amount", value: money(bill.amountCents) },
        { label: "Current status", value: bill.status },
      ],
      warnings: ["This books the cash-out entry. It does not move money through Stripe."],
    };
  },
  handler: async (ctx: AgentContext, input) => payManagerBill(ctx.db, ctx.landlordId, input.billId),
});

const budgetInput = z
  .object({
    fiscalYear: z.number().int().min(2000).max(3000),
    categoryCode: z.string().min(1),
    propertyId: z.string().optional(),
    annualCents: z.number().int().nonnegative().optional().describe("Annual budget in cents, split evenly across 12 months."),
    monthlyAmountsCents: z
      .record(z.string(), z.number().int().nonnegative())
      .optional()
      .describe('Explicit month map { "0": cents, ..., "11": cents }.'),
  })
  .strict();

/** Shared preview for the create/update budget pair (both are the same upsert). */
function budgetPreview(
  kind: "create_manager_budget" | "update_manager_budget",
  input: z.infer<typeof budgetInput>,
): ActionPreview {
  const monthly = input.monthlyAmountsCents;
  const total = monthly
    ? Object.values(monthly).reduce((sum, c) => sum + c, 0)
    : (input.annualCents ?? 0);
  return {
    kind,
    title: kind === "create_manager_budget" ? "Create this budget" : "Update this budget",
    confirmLabel: kind === "create_manager_budget" ? "Create budget" : "Update budget",
    fields: [
      { label: "Fiscal year", value: String(input.fiscalYear) },
      { label: "Category", value: input.categoryCode },
      { label: "Property", value: input.propertyId ?? "All properties" },
      { label: "Annual total", value: money(total) },
      { label: "Split", value: monthly ? "Explicit month-by-month" : "Even across 12 months" },
    ],
  };
}

export const createManagerBudgetTool = defineWriteTool({
  name: "create_manager_budget",
  description:
    "Create a budget for a property/fiscal-year/category (integer cents). Supply either an annual amount (split evenly) or an explicit 12-month map. Requires explicit user confirmation.",
  inputSchema: budgetInput,
  preview: async (_ctx, input) => budgetPreview("create_manager_budget", input),
  handler: async (ctx: AgentContext, input) =>
    upsertManagerBudget(ctx.db, {
      managerUserId: ctx.landlordId,
      propertyId: input.propertyId ?? null,
      fiscalYear: input.fiscalYear,
      categoryCode: input.categoryCode,
      annualCents: input.annualCents ?? null,
      monthlyAmountsCents: input.monthlyAmountsCents ?? null,
    }),
});

export const updateManagerBudgetTool = defineWriteTool({
  name: "update_manager_budget",
  description:
    "Update an existing budget for a property/fiscal-year/category (upsert on the same key). Requires explicit user confirmation.",
  inputSchema: budgetInput,
  preview: async (_ctx, input) => budgetPreview("update_manager_budget", input),
  handler: async (ctx: AgentContext, input) =>
    upsertManagerBudget(ctx.db, {
      managerUserId: ctx.landlordId,
      propertyId: input.propertyId ?? null,
      fiscalYear: input.fiscalYear,
      categoryCode: input.categoryCode,
      annualCents: input.annualCents ?? null,
      monthlyAmountsCents: input.monthlyAmountsCents ?? null,
    }),
});

export const disposeSecurityDepositTool = defineWriteTool({
  name: "dispose_security_deposit",
  description:
    "Dispose a held security deposit at move-out. Supply only the damages/withheld amount in cents; the refund is computed server-side as the remainder of the amount held (the tool computes the split, never the model). Posts the disposition GL entry. Requires explicit user confirmation.",
  inputSchema: z
    .object({
      depositId: z.string().min(1),
      withholdCents: z.number().int().nonnegative().optional().describe("Damages withheld, in cents. Omit or 0 = full refund."),
      itemization: z
        .array(z.object({ label: z.string(), amountCents: z.number().int().nonnegative() }))
        .optional(),
      memo: z.string().optional(),
    })
    .strict(),
  preview: async (ctx, input): Promise<ActionPreview> => {
    const deposit = await getSecurityDepositById(ctx.db, ctx.landlordId, input.depositId);
    if (!deposit) throw new Error("Security deposit not found.");
    // The split is computed here from the stored amount held, exactly as the
    // handler recomputes it — the landlord confirms the real refund figure, not
    // a model-supplied one.
    const split = computeDispositionSplit(deposit.amountHeldCents, input.withholdCents ?? 0);
    return {
      kind: "dispose_security_deposit",
      title: "Dispose this security deposit",
      confirmLabel: "Post disposition",
      fields: [
        { label: "Amount held", value: money(deposit.amountHeldCents) },
        { label: "Withheld for damages", value: money(split.withholdCents) },
        { label: "Refunded to resident", value: money(split.refundCents) },
        { label: "Disposition type", value: split.dispositionType },
        ...(input.memo ? [{ label: "Memo", value: input.memo }] : []),
      ],
      warnings: ["This posts the disposition to the general ledger and cannot be undone from chat."],
    };
  },
  handler: async (ctx: AgentContext, input) => {
    const deposit = await getSecurityDepositById(ctx.db, ctx.landlordId, input.depositId);
    if (!deposit) throw new Error("Security deposit not found.");
    const split = computeDispositionSplit(deposit.amountHeldCents, input.withholdCents ?? 0);
    return disposeSecurityDeposit(ctx.db, {
      managerUserId: ctx.landlordId,
      depositId: input.depositId,
      dispositionType: split.dispositionType,
      refundCents: split.refundCents,
      withholdCents: split.withholdCents,
      itemization: input.itemization,
      memo: input.memo,
    });
  },
});

export const createOwnerDistributionTool = defineWriteTool({
  name: "create_owner_distribution",
  description:
    "Create a draft owner distribution statement for a property and period. The distribution total is computed server-side from beginning balance + cash in − cash out − management fee − reserve holdback + adjustments (all integer cents). Requires explicit user confirmation.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1),
      ownerId: z.string().optional(),
      periodStart: z.string().describe("ISO date YYYY-MM-DD."),
      periodEnd: z.string().describe("ISO date YYYY-MM-DD."),
      beginningBalanceCents: z.number().int().optional(),
      cashInCents: z.number().int().optional(),
      cashOutCents: z.number().int().optional(),
      managementFeeCents: z.number().int().optional(),
      reserveHoldbackCents: z.number().int().optional(),
      adjustmentsCents: z.number().int().optional(),
      memo: z.string().optional(),
    })
    .strict(),
  preview: async (_ctx, input): Promise<ActionPreview> => ({
    kind: "create_owner_distribution",
    title: "Create this owner distribution",
    confirmLabel: "Create draft",
    fields: [
      { label: "Property", value: input.propertyId },
      { label: "Period", value: `${input.periodStart} → ${input.periodEnd}` },
      { label: "Cash in", value: money(input.cashInCents) },
      { label: "Cash out", value: money(input.cashOutCents) },
      { label: "Management fee", value: money(input.managementFeeCents) },
      { label: "Reserve holdback", value: money(input.reserveHoldbackCents) },
    ],
    warnings: [
      "The distribution total is computed server-side from these components when the draft is created.",
      "This creates a draft only — approve it separately to finalize.",
    ],
  }),
  handler: async (ctx: AgentContext, input) =>
    createOwnerDistribution(ctx.db, {
      managerUserId: ctx.landlordId,
      propertyId: input.propertyId,
      ownerId: input.ownerId ?? null,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      beginningBalanceCents: input.beginningBalanceCents,
      cashInCents: input.cashInCents,
      cashOutCents: input.cashOutCents,
      managementFeeCents: input.managementFeeCents,
      reserveHoldbackCents: input.reserveHoldbackCents,
      adjustmentsCents: input.adjustmentsCents,
      memo: input.memo,
    }),
});

export const approveOwnerDistributionTool = defineWriteTool({
  name: "approve_owner_distribution",
  description: "Approve a draft owner distribution statement. Requires explicit user confirmation.",
  inputSchema: z.object({ distributionId: z.string().min(1) }).strict(),
  preview: async (ctx, input): Promise<ActionPreview> => {
    const row = await loadOwnedRow(
      ctx,
      "manager_owner_distributions",
      "id, property_id, period_start, period_end, distribution_cents, status",
      input.distributionId,
    );
    return {
      kind: "approve_owner_distribution",
      title: "Approve this owner distribution",
      confirmLabel: "Approve",
      fields: [
        { label: "Property", value: String(row.property_id ?? "—") },
        { label: "Period", value: `${row.period_start ?? "?"} → ${row.period_end ?? "?"}` },
        { label: "Distribution", value: money(Number(row.distribution_cents ?? 0)) },
        { label: "Current status", value: String(row.status ?? "unknown") },
      ],
    };
  },
  handler: async (ctx: AgentContext, input) =>
    approveOwnerDistribution(ctx.db, ctx.landlordId, input.distributionId),
});

export const reconcileBankStatementLineTool = defineWriteTool({
  name: "reconcile_bank_statement_line",
  description:
    "Reconcile a bank statement line: mark it cleared and/or match it to a ledger entry. Ownership is verified server-side through the owning statement. Requires explicit user confirmation.",
  inputSchema: z
    .object({
      lineId: z.string().min(1),
      matchedLedgerEntryId: z.string().uuid().nullable().optional(),
      matchedExpenseEntryId: z.string().uuid().nullable().optional(),
      cleared: z.boolean().optional(),
    })
    .strict(),
  preview: async (_ctx, input): Promise<ActionPreview> => ({
    kind: "reconcile_bank_statement_line",
    title: "Reconcile this bank line",
    confirmLabel: "Reconcile",
    fields: [
      { label: "Statement line", value: input.lineId },
      {
        label: "Match to ledger entry",
        value: input.matchedLedgerEntryId ? input.matchedLedgerEntryId : "Leave unmatched",
      },
      { label: "Match to expense", value: input.matchedExpenseEntryId || "Unchanged" },
      {
        label: "Cleared",
        value: input.cleared === undefined ? "Unchanged" : input.cleared ? "Yes" : "No",
      },
    ],
    warnings: [
      // The handler verifies the line belongs to this landlord's statement; the
      // preview shows the raw id because the line has no human-readable label.
      "Ownership is re-verified server-side through the owning statement before anything changes.",
    ],
  }),
  handler: async (ctx: AgentContext, input) =>
    reconcileBankStatementLine(ctx.db, ctx.landlordId, input.lineId, {
      matchedLedgerEntryId: input.matchedLedgerEntryId,
      matchedExpenseEntryId: input.matchedExpenseEntryId,
      cleared: input.cleared,
    }),
});

/** All gated manager-financials write tools, for the confirm-gated registry. */
export const managerFinancialsWriteTools = [
  createManagerBillTool,
  approveManagerBillTool,
  recordBillPaymentTool,
  createManagerBudgetTool,
  updateManagerBudgetTool,
  disposeSecurityDepositTool,
  createOwnerDistributionTool,
  approveOwnerDistributionTool,
  reconcileBankStatementLineTool,
];
