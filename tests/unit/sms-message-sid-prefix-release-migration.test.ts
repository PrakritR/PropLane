import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertFunctions, assertLedger, checkCatalog, MIGRATION, parseOptions, reviewedSource } from "../../scripts/sms-message-sid-prefix-release-migration.mjs";
import { reviewedSmsMigrations, sha256 } from "../../scripts/sms-durability-release-manifest.mjs";
import { reviewedSource as reviewedCompletedReceipt } from "../../scripts/sms-completed-receipt-release-migration.mjs";

const source = reviewedSource();
const SID_PATTERN = "~ '^(SM|MM)[0-9a-fA-F]{32}$'";
const completed = reviewedCompletedReceipt();

function rows(applied) {
  return source.bodies.map((fn) => ({
    signature: fn.signature, body: applied ? fn.nextBody : fn.priorBody,
    returnType: fn.returnType, language: "plpgsql", volatility: "v",
    securityDefiner: true, searchPath: "search_path=public, pg_temp", owner: "postgres",
    anonExecute: false, authExecute: false, serviceExecute: true,
  }));
}

function ledger(applied) {
  const firstSix = reviewedSmsMigrations().map(({ version, name, sql }) => ({ version, name, statements: [sql] }));
  const later = [
    ["20260926150000", "sms_completed_receipt_originals"],
    ["20260926190000", "sms_retained_historical_source"],
    ["20260926210000", "sms_notice_atomic_reopen"],
  ].map(([version, name]) => ({ version, name, statements: [readFileSync(new URL(`../../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8")] }));
  return [...firstSix, ...later, ...(applied ? [{ version: MIGRATION.version, name: MIGRATION.name, statements: [source.sql] }] : [])];
}

function catalogClient(change: { table?: string; rpc?: string; resolverBody?: string; missingIndex?: string; changedIndex?: string; missingMarkers?: string; cutoverMissing?: boolean } = {}) {
  const query = vi.fn(async (statement: string, params: string[] = []) => {
    if (statement.includes("select version,name,statements")) return { rows: ledger(true) };
    if (statement.includes("replace(replace(p.oid::regprocedure")) return { rows: rows(true) };
    if (statement.includes("select c.relrowsecurity")) return { rows: [{
      rls: params[0] !== `public.${change.table}`, anon_access: false, auth_access: false, service_access: true,
    }] };
    if (statement.includes("select has_function_privilege('anon',$1")) return { rows: [{
      anon_access: params[0] === `public.${change.rpc}`, auth_access: false, service_access: true,
    }] };
    if (statement.includes("select p.oid::text")) return { rows: [{ oid: "1" }] };
    if (statement.includes("select p.prosrc")) return { rows: [{
      prosrc: change.resolverBody ?? completed.resolverBody, prosecdef: true, provolatile: "v",
      proconfig: ["search_path=public, pg_temp"], owner: "postgres",
      anon_access: false, auth_access: false, service_access: true,
    }] };
    if (statement.includes("select ns.nspname schema_name")) {
      const index = completed.indexes.find((item) => item.name === params[0]);
      if (!index || change.missingIndex === index.name) return { rows: [] };
      return { rows: [{ schema_name: "public", index_kind: "i", table_schema: "public",
        table_name: index.table, method: index.method, is_unique: index.unique,
        is_valid: true, is_ready: true, key_count: index.keys.length,
        key_definitions: change.changedIndex === index.name ? ["wrong_key"] : index.keys,
        predicate: index.predicates[0] }] };
    }
    if (statement === "select ready from public.sms_projection_cutover where singleton=true") {
      return { rows: change.cutoverMissing ? [] : [{ ready: false }] };
    }
    if (statement.includes("select t.tgenabled enabled")) return { rows: [{ enabled: "O", function_name: "queue_sms_projection_manager_log_intent" }] };
    if (statement.includes("select count(*)::integer n")) {
      return { rows: [{ n: statement.includes(`public.${change.missingMarkers}`) ? 1 : 0 }] };
    }
    throw new Error(`Unexpected catalog query: ${statement.slice(0, 70)}`);
  });
  return { query };
}

describe("additive SMS Message SID correction", () => {
  it("changes only exact SM/MM predicates in the latest live function bodies", () => {
    expect(sha256(source.sql)).toBe(MIGRATION.hash);
    const expectedChanges = [1, 3, 1];
    source.bodies.forEach((fn, index) => {
      const old = index === 0 ? "new.message_sid like 'SM%'" : index === 1 ? "v_source_id like 'SM%'" : "v_sid like 'SM%'";
      expect(fn.priorBody.split(old).length - 1).toBe(expectedChanges[index]);
      expect(fn.nextBody).toBe(fn.priorBody.replaceAll(old, () => index === 0 ? `new.message_sid ${SID_PATTERN}` : index === 1 ? `v_source_id ${SID_PATTERN}` : `v_sid ${SID_PATTERN}`));
    });
    expect(source.sql).toContain("where provider_sid is null and source_namespace like 'twilio:%'");
    expect(source.sql).toContain("source_event_id ~ '^(SM|MM)[0-9a-fA-F]{32}$'");
    expect(source.sql.match(/update public\.sms_projection_deleted_events set provider_sid=source_event_id/g)).toHaveLength(1);
    expect(source.sql).toContain("revoke all on function public.project_sms_conversation_event(jsonb) from public,anon,authenticated");
  });

  it("requires exact target, private fresh backup and staging-only rehearsal", () => {
    expect(parseOptions(["--target", "staging"])).toMatchObject({ target: "staging", phase: "preflight" });
    expect(parseOptions(["--target", "staging", "--phase", "rehearsal"])).toMatchObject({ phase: "rehearsal" });
    expect(() => parseOptions(["--target", "production", "--phase", "rehearsal"])).toThrow();
    expect(() => parseOptions(["--target", "production", "--phase", "apply"])).toThrow();
    expect(() => parseOptions(["--target", "staging", "--phase", "apply", "--apply-authorized", "--backup-file", "/tmp/test.dump"])).toThrow();
  });

  it("keeps MM replay, provider deduplication and deletion tombstones in the copied projector", () => {
    const project = source.bodies.find((fn) => fn.name === "project_sms_conversation_event")!.nextBody;
    expect(project).toContain("sms-provider:'||v_owner::text||':'||v_source_id");
    expect(project).toContain("provider_sid=v_source_id");
    expect(project).toContain("sms_projection_deleted_events");
    expect(project).toContain("return jsonb_build_object('skipped','deleted')");
    expect(project).toContain("historical provider event conflicts with live replay");
    expect(project).toContain("v_source_id ~ '^(SM|MM)[0-9a-fA-F]{32}$'");
    expect(source.sql).not.toContain("create unique index");
  });

  it("refuses prior ledger drift and postflight function/ACL drift", () => {
    expect(() => assertLedger(ledger(false), false)).not.toThrow();
    expect(() => assertLedger(ledger(true), true)).not.toThrow();
    expect(() => assertLedger(ledger(true), false)).toThrow();
    const changedLedger = ledger(true); changedLedger[6].statements = ["changed"];
    expect(() => assertLedger(changedLedger, true)).toThrow();
    expect(() => assertFunctions(rows(false), source, false)).not.toThrow();
    expect(() => assertFunctions(rows(true), source, true)).not.toThrow();
    for (const change of [{ body: "wrong" }, { authExecute: true }, { serviceExecute: false }, { securityDefiner: false }, { owner: "other" }]) {
      expect(() => assertFunctions([{ ...rows(true)[0], ...change }, ...rows(true).slice(1)], source, true)).toThrow();
    }
  });

  it("restores the earlier catalog gates and catches a missing old MM tombstone marker", async () => {
    await expect(checkCatalog(catalogClient(), source, true)).resolves.toEqual(expect.any(String));
    await expect(checkCatalog(catalogClient({ table: "sms_projection_turns" }), source, true))
      .rejects.toThrow("SMS table ACL/RLS mismatch");
    await expect(checkCatalog(catalogClient({ rpc: "delete_sms_projection_conversation(uuid,uuid,uuid)" }), source, true))
      .rejects.toThrow("SMS function ACL mismatch");
    await expect(checkCatalog(catalogClient({ resolverBody: "drift" }), source, true))
      .rejects.toThrow("SMS function definition/ACL mismatch");
    await expect(checkCatalog(catalogClient({ missingIndex: completed.indexes[0].name }), source, true))
      .rejects.toThrow("Completed-receipt index definition mismatch");
    await expect(checkCatalog(catalogClient({ changedIndex: completed.indexes[0].name }), source, true))
      .rejects.toThrow("Completed-receipt index definition mismatch");
    await expect(checkCatalog(catalogClient({ cutoverMissing: true }), source, true))
      .rejects.toThrow("SMS cutover singleton missing");
    await expect(checkCatalog(catalogClient({ missingMarkers: "sms_projection_deleted_events" }), source, true))
      .rejects.toThrow("SID correction existing provider markers missing: sms_projection_deleted_events");
  });
});
