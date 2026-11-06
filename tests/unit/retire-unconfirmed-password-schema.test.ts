import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const sql = readFileSync("supabase/migrations/20261030141000_retire_unconfirmed_email_password.sql", "utf8");
describe("unconfirmed password retirement migration", () => {
  it("restricts the guarded operation to service role", () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    expect(sql).toMatch(/revoke all on function[\s\S]+from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]+to service_role/i);
  });
  it("only retires an unused unconfirmed single email identity", () => {
    for (const guard of [/u\.id = p_user_id/, /u\.email_confirmed_at is null/, /u\.phone_confirmed_at is null/, /u\.last_sign_in_at is null/, /u\.deleted_at is null/, /coalesce\(u\.is_sso_user, false\) = false/, /not exists \(select 1 from auth\.sessions/, /from public\.account_recovery_requests/, /count\(\*\) from auth\.identities/, /i\.provider = 'email'/, /i\.identity_data ->> 'email'/]) expect(sql).toMatch(guard);
    expect(sql).toMatch(/set encrypted_password = null/i);
    expect(sql).toMatch(/return changed_id is not null/i);
  });
});
