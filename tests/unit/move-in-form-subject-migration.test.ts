import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030144800_bind_move_in_form_subject.sql", "utf8");
it("serializes subject claim and inserts while restricting adoption and recovery", () => {
  expect(sql.match(/for update/g)).toHaveLength(2);
  expect(sql).toContain("f.application_id = a.id and f.resident_user_id is null and f.status = 'sent'");
  expect(sql).toContain("f.answers = '[]'::jsonb and f.signed_document_sha256 is null and f.submitted_at is null");
  expect(sql).toContain("lower(btrim(f.resident_email)) = verified_email");
  expect(sql).toContain("bound::uuid");
  expect(sql).toContain("coalesce(nullif(a.assigned_property_id, ''), nullif(a.row_data->>'assignedPropertyId', ''), nullif(a.property_id, '')");
  expect(sql).toContain("if nullif(a.row_data->>'setupTokenConsumedAt', '') is null then");
  expect(sql).toContain("nullif(btrim(candidate.resident_email), '') is null");
  expect(sql).toContain("pg_try_advisory_xact_lock_shared");
  expect(sql).toContain("function public.insert_bound_move_in_form(p_form jsonb)");
  expect(sql).toContain("grant execute on function public.insert_bound_move_in_form(jsonb) to service_role");
});

it("routes every move-in form creation through the locked subject RPC", async () => {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : /\.[jt]sx?$/.test(entry.name) ? [path] : [];
    });
  }
  const writers = files("src").filter((path) => /\.from\(\s*["'`]resident_move_in_forms["'`]\s*\)\s*\.insert\s*\(/.test(readFileSync(path, "utf8")));
  expect(writers).toEqual([]);
  expect(readFileSync("src/lib/move-in-forms/server.ts", "utf8")).toMatch(/\.rpc\(\s*["']insert_bound_move_in_form["']/);
});
