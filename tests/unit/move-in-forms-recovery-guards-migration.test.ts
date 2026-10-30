import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030144900_move_in_forms_recovery_guards.sql", "utf8");
it("attaches only the existing recovery triggers and refuses conflicting definitions", () => {
  expect(sql).toContain("c.relname = 'resident_move_in_forms'");
  expect(sql).toContain("existing_trigger.tgtype <> 31");
  expect(sql).toContain("existing_trigger.tgtype <> 9");
  expect(sql).toContain("existing_trigger.tgfoid <> write_guard_function");
  expect(sql).toContain("existing_trigger.tgfoid <> capture_delete_function");
  expect(sql).toContain("existing_trigger.tgenabled <> 'O'");
  expect(sql).toContain("before insert or update or delete on public.resident_move_in_forms");
  expect(sql).toContain("after delete on public.resident_move_in_forms");
  expect(sql).not.toMatch(/\b(?:insert into|update public|delete from|alter table)\b/i);
});
