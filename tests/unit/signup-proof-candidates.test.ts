import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";
import { inspectSignupPurgeCandidates } from "../helpers/signup-proof-candidates";
import type { SignupJournal } from "../helpers/signup-proof-journal";
const actor = "11111111-1111-4111-8111-111111111111";
const journal: SignupJournal = { schemaVersion: 1, target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce: "a".repeat(32), absentBeforeSignup: true, email: `p8-manager-${"a".repeat(32)}-draft@example.invalid`, phone: "+12065550100", fullName: "P8 draft manager", tier: "pro", startedAt: "2026-01-01T00:00:00Z", actorId: actor };
function mockDb(populated: Record<string, Record<string, unknown>[]> = {}, failed?: string) {
  const seen: string[] = [];
  const columns = new Map<string, Set<string>>();
  for (const rule of ACCOUNT_PURGE_TABLES) {
    const set = columns.get(rule.table) ?? new Set<string>();
    for (const scope of [rule.manager, rule.resident]) if (scope) {
      for (const column of [...scope.ids ?? [], ...scope.emails ?? [], ...scope.detachIds ?? [], ...scope.detachEmails ?? []]) set.add(column);
      if (scope.restrict) set.add(scope.restrict.column);
    }
    columns.set(rule.table, set);
  }
  const db = { supabaseUrl: journal.target, from(table: string) {
    if (!columns.has(table)) throw new Error(`Unknown mock table: ${table}`);
    const check = (column: string) => { if (!columns.get(table)!.has(column)) throw new Error(`Unknown mock column: ${table}.${column}`); seen.push(`${table}:${column}`); };
    const query = { select: () => query, eq: (column: string) => { check(column); return query; }, ilike: (column: string) => { check(column); return query; }, neq: (column: string) => { check(column); return query; }, limit: async () => table === failed ? { data: null, error: { code: "FAILED" } } : { data: populated[table] ?? [], count: (populated[table] ?? []).length, error: null } };
    return query;
  } } as unknown as SupabaseClient;
  return { db, seen };
}
it("reads every canonical ownership and detach predicate and accepts narrowly owned rows", async () => {
  const { db, seen } = mockDb({ email_onboarding_handoffs: [{ user_id: actor }] });
  await expect(inspectSignupPurgeCandidates({ db, journal })).resolves.toEqual([{ table: "email_onboarding_handoffs", row: { user_id: actor } }]);
  expect(seen).toContain("email_onboarding_handoffs:user_id");
  expect(seen).toContain("vendor_outreach_workspace_profiles:assigned_by");
  expect(seen).toContain("manager_purchases:email");
});
it("refuses unknown populated rows, foreign ownership, external references and read failures", async () => {
  for (const { db } of [mockDb({ portal_work_order_records: [{ manager_user_id: actor }] }), mockDb({ email_onboarding_handoffs: [{ user_id: "foreign" }] }), mockDb({ manager_purchases: [{ user_id: actor, email: journal.email, tier: "pro", billing: "trial", stripe_checkout_session_id: "cs_real" }] }), mockDb({}, "email_onboarding_handoffs")]) {
    await expect(inspectSignupPurgeCandidates({ db, journal })).rejects.toThrow("Signup cleanup candidate refused.");
  }
});
it("refuses an unjournaled property rather than widening cleanup", async () => {
  const { db } = mockDb({ manager_property_records: [{ id: "foreign", manager_user_id: actor }] });
  await expect(inspectSignupPurgeCandidates({ db, journal })).rejects.toThrow("Signup cleanup candidate refused.");
});
it("refuses financial-history candidates even when tied to the new resident", async () => {
  const resident = { ...journal, tier: "resident" as const, email: `p8-resident-${journal.nonce}-resident@example.invalid`, fullName: "P8 resident manager" };
  const { db } = mockDb({ ledger_entries: [{ resident_user_id: actor, resident_email: resident.email }] });
  await expect(inspectSignupPurgeCandidates({ db, journal: resident })).rejects.toThrow("Signup cleanup candidate refused.");
});

it("accepts only the source-backed application lifecycle aggregate", async () => {
  const { classifySignupCandidate } = await import("../helpers/signup-proof-candidates");
  const { managerTasksStorageKey } = await import("@/lib/manager-tasks");
  const applicationId = "PROPLANE-APP-123456";
  const propertyId = "property-123";
  const manager = { ...journal, inventory: [
    { namespace: "property" as const, state: "resolved" as const, id: propertyId, actorId: actor, marker: journal.nonce },
    { namespace: "application" as const, state: "resolved" as const, id: applicationId, propertyId, actorId: actor, marker: journal.nonce },
  ] };
  const id = managerTasksStorageKey(actor);
  const task = { id: "22222222-2222-4222-8222-222222222222", title: "Review application", propertyId, dueDate: "2026-01-03T00:00:00Z", completed: false, assignee: { type: "team", id: actor, name: "P8" }, taskType: "general", urgency: "deadline", templateKey: "review_application", sourceId: applicationId, dedupKey: `review_application:${applicationId}`, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
  const row = { id, manager_user_id: actor, property_id: null, test_workspace_id: null, record_type: "manager_tasks", row_data: { id, managerUserId: actor, recordType: "manager_tasks", tasks: [task] } };
  await expect(classifySignupCandidate("portal_schedule_records", row, manager)).resolves.toBeUndefined();
  for (const altered of [
    { ...task, assignee: { type: "team", id: "foreign" } },
    { ...task, propertyId: "foreign" }, { ...task, sourceId: "foreign" },
    { ...task, dedupKey: "wrong" }, { ...task, dueDate: "2028-01-01T00:00:00Z" }, { ...task, title: "Unrelated task" }, { ...task, templateKey: "collect_rent" },
    { ...task, attachments: [{ id: "external" }] }, { ...task, externalId: "external" },
  ]) await expect(classifySignupCandidate("portal_schedule_records", { ...row, row_data: { ...row.row_data, tasks: [altered] } }, manager)).rejects.toThrow();
  await expect(classifySignupCandidate("portal_schedule_records", { ...row, test_workspace_id: "foreign" }, manager)).rejects.toThrow();
});

it.each(["pro", "resident"] as const)("requires the saved resident subject and exact role pair for %s application classification", async (tier) => {
  const { classifySignupCandidate } = await import("../helpers/signup-proof-candidates");
  const residentId = "22222222-2222-4222-8222-222222222222", propertyId = "fixture-property", appId = "PROPLANE-ABCDEF12";
  const manager: SignupJournal = { ...journal, inventory: [{ namespace: "application", state: "resolved", id: appId, propertyId, residentActorId: residentId, actorId: actor, marker: journal.nonce }] };
  const resident: SignupJournal = { ...journal, tier: "resident", actorId: residentId, email: "p8-resident-offline@example.invalid" };
  const row = { id: appId, manager_user_id: actor, resident_email: resident.email, property_id: propertyId, row_data: { residentUserId: residentId } };
  const classify = (value: Record<string, unknown>, m = manager, r = resident) => classifySignupCandidate("manager_application_records", value, tier === "pro" ? m : r, tier === "pro" ? r : m);
  await expect(classify(row)).resolves.toBeUndefined();
  for (const row_data of [undefined, null, {}, [], "resident", { residentUserId: null }, { residentUserId: "malformed" }, { residentUserId: 123 }, { residentUserId: "99999999-9999-4999-8999-999999999999" }]) await expect(classify({ ...row, row_data })).rejects.toThrow("refused");
  for (const residentActorId of [undefined, "99999999-9999-4999-8999-999999999999"]) await expect(classify(row, { ...manager, inventory: manager.inventory!.map((entry) => ({ ...entry, residentActorId })) })).rejects.toThrow("refused");
  await expect(classify(row, { ...manager, tier: "resident" })).rejects.toThrow("refused");
  await expect(classify(row, manager, { ...resident, tier: "pro" })).rejects.toThrow("refused");
  for (const changed of [{ manager_user_id: "foreign" }, { resident_email: "foreign@example.invalid" }, { property_id: "foreign" }, { assigned_property_id: "foreign" }, { workspace_id: "foreign" }, { test_workspace_id: "foreign" }, { id: "foreign" }]) await expect(classify({ ...row, ...changed })).rejects.toThrow("refused");
});
