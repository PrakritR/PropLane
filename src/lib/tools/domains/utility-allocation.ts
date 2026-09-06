import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog } from "../audit";
import { allocateUtilityBill } from "@/lib/utility-allocation";
import { migrationDate } from "@/lib/sales-migration/model";
import { migrationDigest, migrationRecordId } from "@/lib/sales-migration/server";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { HouseholdCharge } from "@/lib/household-charges";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import { track } from "@/lib/analytics/posthog";
import { assertFinancialsTier } from "@/lib/reports/auth";

const inputSchema = z.object({
  billId: z.string().uuid(), serviceStart: migrationDate, serviceEnd: migrationDate,
  allocationCents: z.number().int().positive().max(1_000_000_000),
  rule: z.enum(["occupant_days", "occupied_room_days"]),
  applicationIds: z.array(z.string().min(1).max(100)).min(1).max(200),
  excludeIds: z.array(z.string().min(1).max(100)).max(200),
  agreementConfirmed: z.literal(true).describe("The manager explicitly confirmed this allocation rule is permitted by the selected residents' agreements."),
  expectedDigest: z.string().length(64).optional(),
}).strict();
type Input = z.infer<typeof inputSchema>;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function resolveAllocation(ctx: AgentContext, input: Input) {
  const gate = await assertFinancialsTier(ctx.landlordId);
  if (!gate.ok) throw new Error(gate.error);
  if (ctx.managerSmsAccess?.mode === "delegated") throw new Error("Open the owning manager's portal for utility allocations");
  const { data: bill, error: billError } = await ctx.db.from("manager_bills").select("id,property_id,amount_cents,status,description,category_code,vendor_invoice_id").eq("id", input.billId).eq("manager_user_id", ctx.landlordId).single();
  if (billError || !bill || !["approved", "scheduled", "paid"].includes(bill.status) || bill.category_code !== "utilities") throw new Error("Select an approved utility bill in your portfolio");
  if (input.allocationCents > bill.amount_cents) throw new Error("Resident allocation exceeds the source bill");
  const { data: property, error: propertyError } = await ctx.db.from("manager_property_records").select("property_data,row_data").eq("id", bill.property_id).eq("manager_user_id", ctx.landlordId).single();
  if (propertyError || !property) throw new Error("Bill property is not in your portfolio");
  const rawSub = property.property_data?.listingSubmission ?? property.row_data?.submission;
  if (!rawSub?.rooms) throw new Error("Property room inventory is missing");
  const sub = normalizeManagerListingSubmissionV1(rawSub);
  const { data: stored, error } = await ctx.db.from("manager_application_records").select("id,row_data,occupancy_start").in("id", input.applicationIds).eq("manager_user_id", ctx.landlordId);
  if (error || !stored || stored.length !== input.applicationIds.length) throw new Error("Some placements could not be resolved in your portfolio");
  const residents = stored.map(record => {
    const row = openApplicantRow(record.row_data, record.id, true) as DemoApplicantRow;
    if (row.bucket !== "approved" || row.withdrawnAt || (row.assignedPropertyId || row.propertyId) !== bill.property_id || !row.email) throw new Error("Select approved placements on this bill's property");
    if (row.application?.rentalType === "airbnb" || row.application?.rentalType === "short_term") throw new Error("Short-term bookings cannot become long-term utility debtors");
    const assignment = row.assignedRoomChoice || row.application?.roomChoice1 || "";
    const room = sub.rooms.find(r => assignment === `${bill.property_id}::${r.id}`);
    if (!room) throw new Error("Resolve the placement's canonical room first");
    if (!input.excludeIds.includes(row.id) && (row.application?.managerUtilitiesOverride?.trim() || row.manualResidentDetails?.monthlyUtilities != null || room.utilitiesPaymentModel !== "variable")) throw new Error("Fixed, included, and tenant-direct utilities cannot be converted into variable charges");
    return { row, roomId: room.id, start: record.occupancy_start || row.manualResidentDetails?.moveInDate || row.application?.leaseStart || "", end: row.manualResidentDetails?.moveOutDate || row.application?.leaseEnd || null };
  });
  const lines = allocateUtilityBill({ amountCents: input.allocationCents, start: input.serviceStart, end: input.serviceEnd, rule: input.rule, placements: residents.map(r => ({ id: r.row.id, roomId: r.roomId, start: r.start, end: r.end })), excludeIds: input.excludeIds });
  const snapshot = { billId: bill.id, propertyId: bill.property_id as string, invoiceId: bill.vendor_invoice_id, billAmountCents: Number(bill.amount_cents), managerShareCents: Number(bill.amount_cents) - input.allocationCents, serviceStart: input.serviceStart, serviceEnd: input.serviceEnd, rule: input.rule, lines: lines.map(line => ({ ...line, residentName: residents.find(r => r.row.id === line.applicationId)!.row.name, residentEmail: residents.find(r => r.row.id === line.applicationId)!.row.email!, residentUserId: residents.find(r => r.row.id === line.applicationId)!.row.residentUserId ?? null })) };
  return { snapshot, digest: migrationDigest(snapshot) };
}

export const previewUtilityAllocationTool = defineTool({
  name: "preview_utility_allocation", description: "Compute an actual approved utility bill allocation using dated placements. Manager must choose the contractual rule and eligible residents. Fixed fees are preserved. This creates no charges.", inputSchema,
  handler: async (ctx: AgentContext, input) => resolveAllocation(ctx, input),
});

export const allocateUtilityBillTool = defineWriteTool({
  name: "allocate_utility_bill", destructive: true,
  description: "Create utility charges from a reviewed actual bill and occupancy allocation. Explicit confirmation required. Preserves fixed-fee agreements and cannot allocate a source bill twice. Does not pay the utility provider.", inputSchema,
  preview: async (ctx: AgentContext, input) => {
    const { snapshot, digest } = await resolveAllocation(ctx, input);
    return { kind: "allocate_utility_bill", title: "Allocate actual utility bill", confirmLabel: "Create utility charges", fields: [
      { label: "Service period", value: `${input.serviceStart} – ${input.serviceEnd}` }, { label: "Source bill", value: usd(snapshot.billAmountCents) },
      { label: "Rule", value: input.rule === "occupant_days" ? "Occupied resident days" : "Occupied room days, split between roommates" },
      ...snapshot.lines.map(l => ({ label: l.residentName, value: `${usd(l.amountCents)} · ${l.occupiedDays} occupied days` })),
      { label: "Manager retains", value: usd(snapshot.managerShareCents) }, { label: "Excluded placements", value: String(input.excludeIds.length) },
    ], warnings: ["Confirm this rule is allowed by each selected resident's agreement. This creates real charges."], confirmedInput: { ...input, expectedDigest: digest } };
  },
  handler: async (ctx: AgentContext, input) => {
    const id = migrationRecordId(ctx.landlordId, "utility-allocation", input.billId);
    const { expectedDigest, ...request } = input;
    const requestHash = migrationDigest(request);
    const { data: existing, error: readError } = await ctx.db.from("property_utility_allocations").select("request_hash,snapshot,status").eq("id", id).eq("manager_user_id", ctx.landlordId).maybeSingle();
    if (readError) throw new Error(readError.message);
    if (existing && existing.request_hash !== requestHash) throw new Error("This bill already has another allocation; review the existing charges");
    if (existing?.status === "completed") return { reply: "This utility bill was already allocated.", resultSummary: { allocationId: id, alreadyRecorded: true } };
    const resolved = await resolveAllocation(ctx, input);
    if (!expectedDigest || resolved.digest !== expectedDigest) throw new Error("Bill or occupancy changed. Review a fresh allocation before confirming");
    const snapshot = resolved.snapshot;
    if (existing && migrationDigest(existing.snapshot) !== resolved.digest) throw new Error("An incomplete allocation has changed; reconcile it before continuing");
    const audit = await writeAuditLog(ctx, { action: "allocate_utility_bill", toolName: "allocate_utility_bill", inputSummary: { allocationId: id, billId: input.billId, rule: input.rule, amountCents: input.allocationCents } });
    if (!audit.recorded) throw new Error("Could not audit the allocation");
    if (!existing) {
      const { error } = await ctx.db.from("property_utility_allocations").insert({ id, manager_user_id: ctx.landlordId, bill_id: input.billId, property_id: snapshot.propertyId, service_start: input.serviceStart, service_end: input.serviceEnd, request_hash: requestHash, snapshot });
      if (error) throw new Error("Allocation was claimed elsewhere; reload its status");
    }
    for (const line of snapshot.lines.filter(l => l.amountCents > 0)) {
      const chargeId = migrationRecordId(ctx.landlordId, id, line.applicationId);
      const { data: saved, error: savedError } = await ctx.db.from("portal_household_charge_records").select("row_data").eq("id", chargeId).eq("manager_user_id", ctx.landlordId).maybeSingle();
      if (savedError) throw new Error(savedError.message);
      const charge: HouseholdCharge = saved?.row_data ?? { id: chargeId, createdAt: new Date().toISOString(), applicationId: line.applicationId, residentName: line.residentName, residentEmail: line.residentEmail, residentUserId: line.residentUserId, managerUserId: ctx.landlordId, propertyId: snapshot.propertyId, propertyLabel: snapshot.propertyId, kind: "utilities", title: `Utilities ${input.serviceStart} – ${input.serviceEnd}`, amountLabel: usd(line.amountCents), balanceLabel: usd(line.amountCents), status: "pending", blocksLeaseUntilPaid: false, sourceUtilityBillId: input.billId, utilityAllocationId: id };
      if (!saved) {
        const { error } = await ctx.db.from("portal_household_charge_records").insert({ id: chargeId, manager_user_id: ctx.landlordId, resident_email: line.residentEmail, resident_user_id: line.residentUserId, property_id: snapshot.propertyId, status: charge.status, row_data: charge });
        if (error) throw new Error(error.message);
      }
      await syncLedgerChargeEntry(ctx.db, charge);
    }
    const { error } = await ctx.db.from("property_utility_allocations").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", id).eq("manager_user_id", ctx.landlordId);
    if (error) throw new Error(error.message);
    track("charge_created", ctx.userId, { kind: "utilities" });
    return { reply: "Utility charges created. The allocation retains its source bill, service period, rule and resident shares.", resultSummary: { allocationId: id, count: snapshot.lines.length, amountCents: input.allocationCents } };
  },
});
