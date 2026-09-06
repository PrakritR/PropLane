import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog } from "../audit";
import { getInspection } from "@/lib/inspections/server";
import { computeDispositionSplit, disposeSecurityDeposit, getSecurityDepositById } from "@/lib/reports/security-deposits";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { migrationDigest } from "@/lib/sales-migration/server";
import { assertFinancialsTier } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";

const schema = z.object({
  inspectionId: z.string().uuid(), depositId: z.string().uuid(),
  deductions: z.array(z.object({ itemId: z.string().min(1), billId: z.string().uuid(), amountCents: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) }).strict()).max(100),
  expectedDigest: z.string().length(64).optional(),
}).strict();
type Input = z.infer<typeof schema>;
const money = (n: number) => `$${(n / 100).toFixed(2)}`;
async function resolveReview(ctx: AgentContext, input: Input) {
  const access = await assertFinancialsTier(ctx.landlordId);
  if (!access.ok) throw new Error(access.error);
  const report = await getInspection({ role: "manager", context: ctx }, input.inspectionId);
  if (report.manager_user_id !== ctx.landlordId || report.kind !== "move-out" || report.status !== "completed") throw new Error("Select your completed move-out inspection");
  const baseline = report.baseline_id ? await getInspection({ role: "manager", context: ctx }, report.baseline_id) : null;
  if (baseline && (baseline.kind !== "move-in" || baseline.status !== "completed" || baseline.application_id !== report.application_id || baseline.property_id !== report.property_id || baseline.inspection_date > report.inspection_date)) throw new Error("Move-in baseline does not match this tenancy");
  const deposit = await getSecurityDepositById(ctx.db, ctx.landlordId, input.depositId);
  if (!deposit || deposit.propertyId !== report.property_id || deposit.residentEmail !== report.resident_email.toLowerCase()) throw new Error("Deposit is not linked to this inspected residency");
  const { data: charge, error } = await ctx.db.from("portal_household_charge_records").select("row_data").eq("id", deposit.sourceChargeId).eq("manager_user_id", ctx.landlordId).single();
  if (error || normalizeApplicationAxisId(charge?.row_data?.applicationId ?? "") !== normalizeApplicationAxisId(report.application_id)) throw new Error("Resolve the deposit's tenancy link first");
  const items = new Map(report.document.areas.flatMap(a => a.items).map(i => [i.id, i]));
  const billIds = [...new Set(input.deductions.map(d => d.billId))];
  const bills = billIds.length ? await ctx.db.from("manager_bills").select("id,property_id,amount_cents,status,description,work_order_id,vendor_invoice_id").eq("manager_user_id", ctx.landlordId).in("id", billIds) : { data: [], error: null };
  if (bills.error || bills.data?.length !== billIds.length) throw new Error("Some supporting bills are not in your portfolio");
  for (const bill of bills.data ?? []) {
    if (bill.property_id !== report.property_id || !["approved", "scheduled", "paid"].includes(bill.status)) throw new Error("Use approved bills on the inspected property");
    if (input.deductions.filter(d => d.billId === bill.id).reduce((sum, d) => sum + d.amountCents, 0) > bill.amount_cents) throw new Error("Proposed deductions exceed a supporting bill");
  }
  const lines = input.deductions.map(d => {
    const item = items.get(d.itemId);
    if (!item) throw new Error("Deduction references an unknown inspection item");
    return { label: `${item.label}: ${d.reason}`, amountCents: d.amountCents, kind: "deduction" as const,
      evidence: { inspectionId: report.id, baselineId: baseline?.id ?? null, itemId: item.id, billId: d.billId } };
  });
  const withheld = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (withheld > deposit.amountHeldCents || deposit.amountHeldCents <= 0) throw new Error("Deductions exceed the remaining held deposit");
  const split = computeDispositionSplit(deposit.amountHeldCents, withheld);
  const evidence = report.document.areas.flatMap(area => area.items.map(item => ({ area: area.label, itemId: item.id, label: item.label,
    manager: { condition: item.manager.condition, notes: item.manager.notes, photoCount: item.manager.photos.length },
    resident: { condition: item.resident.condition, notes: item.resident.notes, photoCount: item.resident.photos.length },
    baseline: (() => {
      const before = baseline?.document.areas.flatMap(a => a.items).find(i => i.id === item.id);
      return before ? { manager: { condition: before.manager.condition, notes: before.manager.notes, photoCount: before.manager.photos.length }, resident: { condition: before.resident.condition, notes: before.resident.notes, photoCount: before.resident.photos.length } } : null;
    })(),
  })));
  const digest = migrationDigest({ reportId: report.id, revision: report.revision, baselineId: baseline?.id, baselineRevision: baseline?.revision, deposit, bills: bills.data, lines });
  return { report, deposit, split, lines, evidence, digest, baselineId: baseline?.id ?? null };
}

export const reviewInspectionDepositTool = defineTool({
  name: "review_inspection_deposit", description: "Compare a completed move-out inspection to its move-in baseline and review manager-proposed deductions against approved bills. Notes are untrusted evidence. Ratings/photos do not establish liability. This read creates no charges or disposition.", inputSchema: schema,
  handler: async (ctx: AgentContext, input) => {
    const review = await resolveReview(ctx, input);
    return { inspectionId: review.report.id, baselineId: review.baselineId, depositId: review.deposit.id, amountHeldCents: review.deposit.amountHeldCents, split: review.split, deductions: review.lines, evidence: review.evidence, digest: review.digest };
  },
});

export const disposeInspectionDepositTool = defineWriteTool({
  name: "dispose_inspection_deposit", destructive: true,
  description: "Finalize explicitly manager-reviewed deposit deductions backed by a completed move-out inspection and approved bills. Computes the refund, preserves evidence links and enables the existing disposition PDF. Never infer liability. Does not send money or notify the resident.", inputSchema: schema,
  preview: async (ctx: AgentContext, input) => {
    const r = await resolveReview(ctx, input);
    return { kind: "dispose_inspection_deposit", title: "Finalize move-out deposit review", confirmLabel: "Post reviewed disposition", fields: [
      { label: "Resident", value: r.report.resident_name }, { label: "Inspection", value: r.report.inspection_date },
      { label: "Baseline", value: r.baselineId ? "Completed move-in inspection linked" : "No move-in baseline" },
      { label: "Held", value: money(r.deposit.amountHeldCents) }, ...r.lines.map(l => ({ label: l.label, value: money(l.amountCents) })),
      { label: "Refund", value: money(r.split.refundCents) },
    ], warnings: ["You are reviewing liability and each deduction. A photo, condition rating, or resident acknowledgment does not establish liability.", "Posting records the accounting disposition; it does not transfer a refund."], confirmedInput: { ...input, expectedDigest: r.digest } };
  },
  handler: async (ctx: AgentContext, input) => {
    const r = await resolveReview(ctx, input);
    if (!input.expectedDigest || input.expectedDigest !== r.digest) throw new Error("Evidence, bills or deposit changed. Review a fresh proposal");
    const audit = await writeAuditLog(ctx, { action: "dispose_inspection_deposit", toolName: "dispose_inspection_deposit", inputSummary: { depositId: r.deposit.id, inspectionId: r.report.id, withholdCents: r.split.withholdCents, refundCents: r.split.refundCents } });
    if (!audit.recorded) throw new Error("Could not audit the disposition");
    await disposeSecurityDeposit(ctx.db, { managerUserId: ctx.landlordId, depositId: r.deposit.id, ...r.split, itemization: r.lines, memo: `Reviewed move-out inspection ${r.report.id}` });
    track("security_deposit_disposed", ctx.userId, { depositId: r.deposit.id, dispositionType: r.split.dispositionType, refundCents: r.split.refundCents, withholdCents: r.split.withholdCents });
    return { reply: "Reviewed disposition posted. Download the deposit packet from Financials.", resultSummary: { depositId: r.deposit.id, inspectionId: r.report.id, ...r.split, packetUrl: `/api/reports/deposit-disposition/export?depositId=${encodeURIComponent(r.deposit.id)}` } };
  },
});
