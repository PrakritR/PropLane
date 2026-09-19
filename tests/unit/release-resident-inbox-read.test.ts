import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESIDENT_TARGETS, RESIDENT_IDENTITY, RESIDENT_SOURCE_SHA256,
  expectedResidentFunction, residentFunctionGuardSql, guardedResidentMigrationSql,
  residentRecoverySql, assertResidentReadReady, assertResidentPostState,
} from "../../scripts/release-resident-inbox-read.mjs";
import { sha256 } from "../../scripts/release-conversation-schema-reconciliation.mjs";

const root = path.resolve(__dirname, "../..");
const original = readFileSync(path.join(root, "supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql"), "utf8");
const migration = readFileSync(path.join(root, `supabase/migrations/${RESIDENT_IDENTITY}.sql`), "utf8");
const originalBody = original.match(/\bas \$\$([\s\S]*?)\$\$;/)![1];
const fn = {
  definition: `CREATE OR REPLACE FUNCTION public.mark_portal_inbox_source_read(p_id text, p_scope text, p_owner_user_id uuid, p_participant_email text, p_thread_type text, p_updated_at timestamp with time zone, p_row_data jsonb)\n RETURNS boolean\n LANGUAGE sql\n SET search_path TO ''\nAS $function$${originalBody}$function$\n`,
  owner: "postgres", acl: ["postgres=X/postgres", "service_role=X/postgres"],
  config: ['search_path=""'], securityDefiner: false,
};
const ledger = [{ version: "20260913170000", name: "mark_portal_inbox_source_read", statements: [original], extra: "preserve exact metadata" }];
const before = { target: RESIDENT_TARGETS.dev, capturedAt: "2026-09-19T12:00:00Z", ledger, inbox_function: fn };
const added = { version: RESIDENT_IDENTITY.slice(0, 14), name: RESIDENT_IDENTITY.slice(15), statements: ["actual CLI-captured statement"], extra: null };
const after = () => ({ ...before, inbox_function: expectedResidentFunction(fn), ledger: [...ledger, added] });

describe("resident inbox read release guards", () => {
  it("pins the three targets and exactly one additive source", () => {
    expect(RESIDENT_TARGETS).toEqual({ dev: "emstjswhotsnyksqhqyf", staging: "xwszcafaontidfgznlxd", production: "qahnczmilgptcedaqype" });
    expect(sha256(migration)).toBe(RESIDENT_SOURCE_SHA256);
    expect(migration).toBe(original.replace("scope = 'axis_portal_inbox_manager_v1'", "scope in ('axis_portal_inbox_manager_v1', 'axis_portal_inbox_resident_v1')"));
  });

  it("retains exact metadata while changing only the pinned scope predicate", () => {
    const expected = expectedResidentFunction(fn);
    expect(expected).toEqual({ ...fn, definition: fn.definition.replace("scope = 'axis_portal_inbox_manager_v1'", "scope in ('axis_portal_inbox_manager_v1', 'axis_portal_inbox_resident_v1')") });
    expect(() => expectedResidentFunction({ ...fn, securityDefiner: true })).toThrow(/metadata/);
    expect(() => expectedResidentFunction({ ...fn, definition: fn.definition.replace("owner_user_id = p_owner_user_id", "true") })).toThrow(/original function/);
    expect(() => expectedResidentFunction(expected)).toThrow(/original function/);
  });

  it("guards the exact invoker RPC, function bytes, privileges and configuration", () => {
    const sql = residentFunctionGuardSql(fn);
    expect(sql).toContain("public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamp with time zone,jsonb)");
    expect(sql).toContain("and not f.prosecdef");
    expect(sql).toContain("f.provolatile='v'");
    expect(sql).toContain("a.grantee=0");
    expect(sql).toContain("not has_function_privilege('anon'");
    expect(sql).toContain("not has_function_privilege('authenticated'");
    expect(sql).toContain("has_function_privilege('service_role'");
    expect(sql).toContain("to_jsonb(f.proacl)");
    expect(sql).toContain("to_jsonb(f.proconfig)");
    expect(sql).not.toContain("persist_lease_with_action_event");
  });

  it("keeps ledger and inbox locks in the CLI transaction and refuses edited SQL", () => {
    const sql = guardedResidentMigrationSql(before);
    expect(sql).toContain("lock table supabase_migrations.schema_migrations in exclusive mode");
    expect(sql).toContain("lock table public.portal_inbox_thread_records in share row exclusive mode");
    expect(sql).toContain("full ledger differs");
    expect(sql).toContain("ledger array dimensions differ");
    expect(sql).not.toMatch(/^\s*(?:begin|commit);/mi);
    expect(sql.indexOf("full ledger differs")).toBeLessThan(sql.indexOf("create or replace function"));
    expect(sql.lastIndexOf("resident read function contract differs")).toBeGreaterThan(sql.indexOf("grant execute"));
    expect(() => guardedResidentMigrationSql(before, `${migration}\n`)).toThrow(/digest/);
    expect(() => guardedResidentMigrationSql({ ...before, ledger: [...ledger, added] })).toThrow(/already present/);
  });

  it("prepares a guarded inverse without deleting or fabricating migration history", () => {
    const recovery = residentRecoverySql(fn);
    expect(recovery).toContain("NEW reviewed migration");
    expect(recovery).toContain(fn.definition);
    expect(recovery).toContain("resident read function contract differs");
    expect(recovery).not.toMatch(/delete\s+from|migration\s+repair/i);
  });

  it("rejects fabricated apply tokens before filesystem or transport access", () => {
    expect(() => assertResidentReadReady({}, {})).toThrow(/one-use dry-run token/);
    expect(() => assertResidentReadReady({ manifestSha256: "x", approvalSha256: "y" }, { identity: RESIDENT_IDENTITY })).toThrow(/one-use dry-run token/);
    expect(() => assertResidentReadReady(null, null)).toThrow(/one-use dry-run token/);
  });

  it("checks complete historical rows and exact post-function before returning an actual-row receipt", () => {
    expect(assertResidentPostState(before, after())).toEqual({ identity: RESIDENT_IDENTITY, ledgerRowSha256: sha256(JSON.stringify({ extra: null, name: added.name, statements: added.statements, version: added.version })) });
    expect(() => assertResidentPostState(before, { ...after(), target: RESIDENT_TARGETS.production })).toThrow(/target/);
    expect(() => assertResidentPostState(before, { ...after(), inbox_function: fn })).toThrow(/function/);
    expect(() => assertResidentPostState(before, { ...after(), ledger: [{ ...ledger[0], statements: [`${original} `] }, added] })).toThrow(/historical ledger/);
    expect(() => assertResidentPostState(before, { ...after(), ledger: [{ ...ledger[0], extra: "changed" }, added] })).toThrow(/historical ledger/);
    expect(() => assertResidentPostState(before, { ...after(), ledger: [...ledger, { ...added, statements: [] }] })).toThrow(/truthful/);
  });
});
