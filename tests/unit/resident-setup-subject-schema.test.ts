import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261030144400_bind_resident_setup_subject.sql", "utf8");
describe("resident setup subject binding schema", () => {
  it("locks the exact application and requires mailbox, capability, expiry and subject", () => {
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/pg_try_advisory_xact_lock_shared\(723081447301::bigint\)/i);
    expect(sql).toMatch(/errcode = '40001'/i);
    expect(sql).toMatch(/email_confirmed_at is not null.*for share/i);
    expect(sql).toMatch(/account_recovery_requests.*archiving.*retained.*recovering.*purging/i);
    expect(sql).toMatch(/where id = p_application for update/i);
    expect(sql).toMatch(/setupTokenHash.*p_digest/i);
    expect(sql).toMatch(/setupTokenExpiresAt.*<= now\(\)/i);
    expect(sql).toMatch(/bound <> p_user::text/i);
    expect(sql).toMatch(/setupTokenConsumedAt.*return bound = p_user::text/i);
  });
  it("limits the binding RPC to service role", () => {
    expect(sql).toMatch(/revoke all on function public\.bind_resident_setup_subject\(text, uuid, text\) from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.bind_resident_setup_subject\(text, uuid, text\) to service_role/i);
  });
});
