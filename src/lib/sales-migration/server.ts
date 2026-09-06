import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { HouseholdCharge } from "@/lib/household-charges";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { sealApplicantRow, openApplicantRow } from "@/lib/security/applicant-identity";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";
import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import { importSecurityDepositHistory, getSecurityDepositByChargeId } from "@/lib/reports/security-deposits";
import { recordManualExpense, recordManualIncome, MANUAL_EXPENSE_CODES, MANUAL_INCOME_CODES } from "@/lib/reports/manual-entries.server";
import { postGlExpenseEntry, postGlManualIncomeEntry } from "@/lib/reports/gl-posting";
import { categoryCodeForChargeKind } from "@/lib/reports/categories";
import { writeAuditLog } from "@/lib/tools/audit";
import { validateMigration, type SalesMigration, type MigrationTenancy, type FinancialFact } from "./model";

type PropertyPlan = SalesMigration["properties"][number];
type PropertyRecord = { id: string; manager_user_id: string; row_data: Record<string, unknown> | null; property_data: Record<string, unknown> | null; updated_at: string };
export type MigrationResult = { digest: string; physicalRooms: number; completed: number; skipped: number; blocked: { key: string; reason: string }[] };
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const migrationDigest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
/** UUID-shaped hash for tables with UUID keys; includes owner, workbook and tenancy/source identity. */
export function migrationRecordId(...parts: string[]) {
  const h = migrationDigest(parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function check(error: { message: string } | null) { if (error) throw new Error(error.message); }
function submission(record: PropertyRecord): ManagerListingSubmissionV1 {
  const raw = record.property_data?.listingSubmission ?? record.row_data?.submission;
  if (!raw || typeof raw !== "object" || (raw as { v?: number }).v !== 1 || !Array.isArray((raw as { rooms?: unknown }).rooms)) throw new Error("Property needs a canonical listing submission before import");
  return normalizeManagerListingSubmissionV1(raw as ManagerListingSubmissionV1);
}
async function loadProperty(db: SupabaseClient, owner: string, id: string): Promise<PropertyRecord> {
  const { data, error } = await db.from("manager_property_records").select("id,manager_user_id,row_data,property_data,updated_at").eq("id", id).eq("manager_user_id", owner).single();
  check(error);
  if (!data) throw new Error("Property mapping is not owned by this manager");
  return data as PropertyRecord;
}

/** Read-only validation. The digest pins both the reviewed input and current property snapshots. */
export async function previewSalesMigration(db: SupabaseClient, owner: string, raw: unknown) {
  const plan = validateMigration(raw);
  const snapshots: PropertyRecord[] = [];
  for (const property of plan.properties) {
    const record = await loadProperty(db, owner, property.propertyId);
    const sub = submission(record);
    const mapped = new Set(property.rooms.map(r => r.roomId));
    if (sub.rooms.length !== mapped.size || sub.rooms.some(r => !mapped.has(r.id))) throw new Error(`Map every existing room in ${property.propertyKey}; create missing rooms through the listing workflow before migration`);
    for (const room of property.rooms) {
      const existing = sub.rooms.find(r => r.id === room.roomId);
      if (existing && existing.name.replace(/\s/g, "").toLowerCase() !== `room${room.roomNumber}`) throw new Error(`Room label mapping needs review: ${property.propertyKey} Room ${room.roomNumber}`);
    }
    for (const fact of property.facts) {
      if (["opening_balance", "payment", "deposit_held"].includes(fact.kind) && fact.categoryCode !== categoryCodeForChargeKind(fact.kind === "deposit_held" ? "security_deposit" : fact.chargeKind)) throw new Error("Historical charge category does not match its canonical charge kind");
      if (fact.kind === "income" && !MANUAL_INCOME_CODES.has(fact.categoryCode)) throw new Error("Choose a canonical income category");
      if (fact.kind === "expense" && !MANUAL_EXPENSE_CODES.has(fact.categoryCode)) throw new Error("Choose a canonical expense category");
    }
    for (const stay of property.tenancies) {
      const id = migrationRecordId(owner, plan.workbookId, property.propertyId, "tenancy", stay.tenancyKey);
      const expectedId = stay.existingApplicationId ? normalizeApplicationAxisId(stay.existingApplicationId) : `PROPLANE-${id.replace(/-/g, "").toUpperCase()}`;
      const { data: matches, error } = await db.from("manager_application_records").select("id,row_data").eq("manager_user_id", owner).eq("resident_email", stay.email.toLowerCase()).limit(1000);
      check(error);
      if (matches?.length === 1000) throw new Error("Narrow the resident identity mapping before import");
      for (const match of matches ?? []) {
        const row = openApplicantRow(match.row_data, match.id, true) as DemoApplicantRow;
        if (normalizeApplicationAxisId(match.id) !== expectedId && !row.withdrawnAt && row.bucket === "approved" && (row.assignedPropertyId || row.propertyId) === property.propertyId && row.assignedRoomChoice === `${property.propertyId}::${stay.roomId}` && (row.manualResidentDetails?.moveInDate || row.application?.leaseStart) === stay.start) throw new Error("This tenancy already exists; explicitly map its application id before importing");
      }
    }
    snapshots.push(record);
  }
  return { plan, snapshots, digest: migrationDigest({ owner, plan, properties: snapshots.map(r => ({ id: r.id, updatedAt: r.updated_at })) }), physicalRooms: plan.inventory.reduce((sum, p) => sum + p.roomCount, 0), unresolved: plan.unresolved.length };
}

/**
 * Insert-only source receipts. A changed source is a reconciliation conflict,
 * never permission to overwrite a tenant or a payment the manager subsequently edited.
 * Each canonical operation below uses a deterministic id and is safe after an uncertain write.
 */
async function step(db: SupabaseClient, owner: string, plan: SalesMigration, property: PropertyPlan,
  kind: string, source: FinancialFact["source"], payload: unknown, run: (id: string) => Promise<string>, result: MigrationResult) {
  const id = migrationRecordId(owner, plan.workbookId, property.propertyId, kind, source.recordKey);
  const hash = migrationDigest(payload);
  const { error: insertError } = await db.from("sales_migration_records").upsert({ id, manager_user_id: owner, workbook_id: plan.workbookId, property_id: property.propertyId, record_kind: kind, source_key: source.recordKey, source_sheet: source.sheet, source_range: source.range, payload_hash: hash }, { onConflict: "id", ignoreDuplicates: true });
  check(insertError);
  const { data, error } = await db.from("sales_migration_records").select("payload_hash,status,canonical_id").eq("id", id).eq("manager_user_id", owner).single();
  check(error);
  if (!data || data.payload_hash !== hash) throw new Error("Source changed after import preparation; reconcile it as a separate correction");
  if (data.status === "completed") { result.skipped++; return String(data.canonical_id); }
  const canonicalId = await run(id);
  const { error: completeError } = await db.from("sales_migration_records").update({ status: "completed", canonical_id: canonicalId, completed_at: new Date().toISOString() }).eq("id", id).eq("manager_user_id", owner).eq("payload_hash", hash);
  check(completeError);
  result.completed++;
  return canonicalId;
}

function applicationFor(owner: string, property: PropertyPlan, stay: MigrationTenancy, id: string): DemoApplicantRow {
  const choice = `${property.propertyId}::${stay.roomId}`;
  return {
    id, name: stay.name, email: stay.email.toLowerCase(), property: property.propertyKey,
    propertyId: property.propertyId, assignedPropertyId: property.propertyId, assignedRoomChoice: choice,
    managerUserId: owner, bucket: "approved", stage: "Existing resident", detail: "Imported tenancy — billing awaiting reconciliation",
    manuallyAdded: true, migrationBillingHold: true, signedMonthlyRent: stay.monthlyRentCents / 100,
    manualResidentDetails: { phone: stay.phone, moveInDate: stay.start, moveOutDate: stay.end ?? undefined, monthlyUtilities: stay.fixedUtilitiesCents == null ? undefined : stay.fixedUtilitiesCents / 100, roomNumber: stay.roomId, leaseTerm: stay.monthToMonth ? "Month to month" : "Fixed term" },
    application: { ...createInitialRentalWizardState(), fullLegalName: stay.name, email: stay.email.toLowerCase(), phone: stay.phone ?? "", propertyId: property.propertyId, roomChoice1: choice, leaseStart: stay.start, leaseEnd: stay.end ?? "", leaseTerm: stay.monthToMonth ? "Month to month" : "Fixed term", dateSigned: "", managerRentOverride: String(stay.monthlyRentCents / 100), managerUtilitiesOverride: stay.fixedUtilitiesCents == null ? "" : String(stay.fixedUtilitiesCents / 100) },
  };
}
async function loadApplication(db: SupabaseClient, owner: string, id: string): Promise<DemoApplicantRow | null> {
  const { data, error } = await db.from("manager_application_records").select("id,row_data").eq("id", id).eq("manager_user_id", owner).maybeSingle();
  check(error);
  return data ? openApplicantRow(data.row_data, data.id, true) as DemoApplicantRow : null;
}
function assertStayMatch(row: DemoApplicantRow, property: PropertyPlan, stay: MigrationTenancy) {
  if (row.withdrawnAt || row.bucket !== "approved" || row.email?.trim().toLowerCase() !== stay.email.toLowerCase() || (row.assignedPropertyId || row.propertyId) !== property.propertyId || row.assignedRoomChoice !== `${property.propertyId}::${stay.roomId}` || (row.manualResidentDetails?.moveInDate || row.application?.leaseStart) !== stay.start) throw new Error("Existing application does not match this tenancy; review the identity mapping");
}

async function importCharge(db: SupabaseClient, owner: string, property: PropertyPlan, fact: FinancialFact, row: DemoApplicantRow, id: string) {
  const existing = await db.from("portal_household_charge_records").select("row_data").eq("id", id).eq("manager_user_id", owner).maybeSingle();
  check(existing.error);
  const paid = fact.kind !== "opening_balance";
  const charge: HouseholdCharge = existing.data?.row_data ?? {
    id, migrationSourceId: id, createdAt: `${fact.date}T12:00:00Z`, applicationId: row.id,
    residentEmail: row.email!, residentName: row.name, residentUserId: row.residentUserId ?? null,
    propertyId: property.propertyId, propertyLabel: property.propertyKey, managerUserId: owner,
    kind: fact.kind === "deposit_held" ? "security_deposit" : fact.chargeKind ?? "other_cost",
    title: fact.description, amountLabel: `$${(fact.amountCents / 100).toFixed(2)}`, balanceLabel: paid ? "$0.00" : `$${(fact.amountCents / 100).toFixed(2)}`,
    status: paid ? "paid" : "pending", paidAt: paid ? `${fact.date}T12:00:00Z` : undefined,
    paidAmountCents: paid ? fact.amountCents : 0, blocksLeaseUntilPaid: false, dueDateLabel: fact.date,
    cancelledReminders: ["7d", "5d", "3d", "12h", "overdue_daily"],
  };
  if (!existing.data) {
    const { error } = await db.from("portal_household_charge_records").insert({ id, manager_user_id: owner, resident_email: row.email, resident_user_id: row.residentUserId ?? null, property_id: property.propertyId, status: charge.status, row_data: charge, updated_at: new Date().toISOString() });
    check(error);
  }
  // Silent write-through ledger: no lifecycle events, reminders, invitations or payments.
  await syncLedgerChargeEntry(db, charge);
  return id;
}

export async function executeSalesMigration(db: SupabaseClient, owner: string, raw: unknown, confirmedDigest: string): Promise<MigrationResult> {
  const preview = await previewSalesMigration(db, owner, raw);
  if (confirmedDigest !== preview.digest) throw new Error("Plan or property changed. Preview again before execution");
  const { plan } = preview;
  const result: MigrationResult = { digest: preview.digest, physicalRooms: preview.physicalRooms, completed: 0, skipped: 0, blocked: plan.unresolved.map(r => ({ key: `${r.propertyKey}:${r.source.range}`, reason: r.reason })) };
  const audit = await writeAuditLog({ db, userId: owner, landlordId: owner }, { action: "sales_migration", toolName: "sales_migration", inputSummary: { planDigest: preview.digest, properties: plan.properties.length, rooms: preview.physicalRooms } });
  if (!audit.recorded) throw new Error("Import audit could not be recorded");
  for (const property of plan.properties) {
    try {
      await step(db, owner, plan, property, "inventory", { sheet: property.sheet, range: "inventory", recordKey: "physical-rooms" }, property.rooms, async () => {
        const record = await loadProperty(db, owner, property.propertyId);
        const sub = submission(record);
        if (sub.rooms.length !== property.rooms.length || property.rooms.some(r => !sub.rooms.some(existing => existing.id === r.roomId))) throw new Error("Canonical inventory changed; review the room mapping");
        return property.propertyId;
      }, result);
    } catch (e) { result.blocked.push({ key: property.propertyKey, reason: String(e instanceof Error ? e.message : e) }); continue; }
    const residents = new Map<string, DemoApplicantRow>();
    for (const stay of property.tenancies) {
      try {
        const applicationId = await step(db, owner, plan, property, "tenancy", { ...stay.source, recordKey: stay.tenancyKey }, stay, async id => {
          const appId = stay.existingApplicationId ? normalizeApplicationAxisId(stay.existingApplicationId) : `PROPLANE-${id.replace(/-/g, "").toUpperCase()}`;
          let row = await loadApplication(db, owner, appId);
          if (!row && stay.existingApplicationId) throw new Error("Mapped existing application was not found");
          if (row) assertStayMatch(row, property, stay);
          else {
            row = applicationFor(owner, property, stay, appId);
            const { error } = await db.from("manager_application_records").insert({ id: appId, manager_user_id: owner, resident_email: row.email, property_id: property.propertyId, assigned_property_id: property.propertyId, row_data: sealApplicantRow(row, appId, owner) });
            check(error); // Atomic shared-room trigger arbitrates the last bed before any account/lease side effect.
          }
          const provisioned = await provisionApprovedResidentAccount(db, row, { mode: "silent_migration" });
          if (!provisioned.ok) throw new Error(provisioned.error);
          // Read again to preserve concurrent manager edits, then use a revision predicate.
          const { data: current, error: readError } = await db.from("manager_application_records").select("row_data,updated_at").eq("id", appId).eq("manager_user_id", owner).single();
          check(readError);
          row = { ...openApplicantRow(current!.row_data, appId, true) as DemoApplicantRow, residentUserId: provisioned.userId };
          assertStayMatch(row, property, stay);
          const { data: linked, error: linkError } = await db.from("manager_application_records").update({ row_data: sealApplicantRow(row, appId, owner), updated_at: new Date().toISOString() }).eq("id", appId).eq("manager_user_id", owner).eq("updated_at", current!.updated_at).select("id");
          check(linkError);
          if (!linked?.length) throw new Error("Resident changed during account linking; retry after review");
          const onboarding = await runExistingResidentOnboarding(db, { userId: owner, email: "" }, row, { sendWelcomeEmail: false, preserveExistingLease: true });
          if (!onboarding.ok) throw new Error(onboarding.error);
          return appId;
        }, result);
        const resident = await loadApplication(db, owner, applicationId);
        if (!resident) throw new Error("Imported application no longer exists");
        assertStayMatch(resident, property, stay);
        residents.set(stay.tenancyKey, resident);
      } catch (e) { result.blocked.push({ key: stay.tenancyKey, reason: String(e instanceof Error ? e.message : e) }); }
    }
    for (const fact of property.facts.filter(f => !f.depositRecordKey)) {
      try {
        await step(db, owner, plan, property, "financial", fact.source, fact, async id => {
          if (fact.kind === "income" || fact.kind === "expense") {
            const expense = fact.kind === "expense";
            const table = expense ? "manager_expense_entries" : "ledger_entries";
            const { data: existing, error } = await db.from(table).select("*").eq("id", id).eq("manager_user_id", owner).maybeSingle();
            check(error);
            if (existing && (Number(existing.amount_cents) !== fact.amountCents || existing.category_code !== fact.categoryCode || existing.property_id !== property.propertyId || (expense ? existing.expense_date : existing.posted_date) !== fact.date)) throw new Error("Canonical transaction changed during import; reconcile before posting its journal");
            if (!existing) {
              const recorded = expense
                ? await recordManualExpense(db, owner, { propertyId: property.propertyId, amountCents: fact.amountCents, categoryCode: fact.categoryCode, expenseDate: fact.date, memo: fact.description }, { id })
                : await recordManualIncome(db, owner, { propertyId: property.propertyId, amountCents: fact.amountCents, categoryCode: fact.categoryCode, postedDate: fact.date, description: fact.description }, { id });
              if (!recorded.ok) throw new Error(recorded.error);
            }
            const base = { managerUserId: owner, propertyId: property.propertyId, categoryCode: fact.categoryCode, amountCents: fact.amountCents, entryDate: fact.date, sourceId: id, memo: fact.description };
            if (expense) await postGlExpenseEntry(db, { ...base, expenseId: id });
            else await postGlManualIncomeEntry(db, { ...base, sourceChargeId: id, description: fact.description, linkLedgerEntryId: id });
            return id;
          }
          const row = residents.get(fact.tenancyKey!);
          if (!row) throw new Error("Resolve tenancy before importing its money");
          return importCharge(db, owner, property, fact, row, id);
        }, result);
      } catch (e) { result.blocked.push({ key: fact.source.recordKey, reason: String(e instanceof Error ? e.message : e) }); }
    }
    for (const receipt of property.facts.filter(f => f.kind === "deposit_held")) {
      const adjustments = property.facts.filter(f => f.depositRecordKey === receipt.source.recordKey);
      if (!adjustments.length) continue;
      try {
        await step(db, owner, plan, property, "deposit-history", receipt.source, adjustments, async () => {
          const chargeId = migrationRecordId(owner, plan.workbookId, property.propertyId, "financial", receipt.source.recordKey);
          const deposit = await getSecurityDepositByChargeId(db, owner, chargeId);
          if (!deposit) throw new Error("Deposit receipt is not reconciled");
          const itemization = adjustments.map(f => ({ label: `${f.description} [${f.source.range}]`, amountCents: f.amountCents, kind: f.kind === "deposit_refund" ? "refund" as const : "deduction" as const, date: f.date, sourceId: migrationRecordId(owner, plan.workbookId, property.propertyId, "deposit-history", f.source.recordKey) }));
          const disposed = await importSecurityDepositHistory(db, owner, deposit.id, receipt.amountCents, itemization);
          return disposed.id;
        }, result);
      } catch (e) { result.blocked.push({ key: receipt.source.recordKey, reason: String(e instanceof Error ? e.message : e) }); }
    }
  }
  return result;
}
