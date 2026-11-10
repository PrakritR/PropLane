import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261106120000_identity_deposit_recovery_guards.sql", "utf8");
it("requires and attaches the exact recovery triggers on six owned tables", () => {
  for (const table of ["resident_identity_subjects", "resident_identity_inquiries", "resident_identity_webhook_events", "resident_identity_manual_reviews", "resident_evidence_policies", "security_deposit_return_attempts"]) expect(sql).toContain(`'${table}'`);
  for (const signature of ["tgtype <> 31", "tgtype <> 9", "tgfoid <> write_guard_function", "tgfoid <> capture_delete_function", "tgenabled <> 'O'", "tgnargs <> 0", "tgqual is not null", "tgconstraint <> 0", "tgattr::text <> ''", "tgisinternal"]) expect(sql).toContain(signature);
  expect(sql).toContain("recovery guard prerequisites missing");
  expect(sql).toContain("before insert or update or delete on public.%I");
  expect(sql).toContain("after delete on public.%I");
  expect(sql).not.toContain("security_deposit_unmatched_refunds");
});
