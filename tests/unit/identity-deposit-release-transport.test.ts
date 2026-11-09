import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCatalog, assertPrivateDirectory, parseOptions, transaction, safeErrorMessage, verifyCommittedPostflight, COMMITTED_UNVERIFIED } from "../../scripts/identity-deposit-release-migrations.mjs";

const ref = "xwszcafaontidfgznlxd";
const base = ["--target", "staging", "--confirm-ref", ref];
describe("release transport refusal", () => {
  it("requires exact target, private artifact, and explicit authorization", () => {
    expect(() => parseOptions([...base, "--catalog-file", "/tmp/catalog"])).not.toThrow();
    expect(() => parseOptions(["--target", "staging", "--confirm-ref", "wrong", "--catalog-file", "/tmp/c"])).toThrow();
    expect(() => parseOptions([...base, "--unknown", "yes"])).toThrow();
    expect(() => parseOptions([...base, "--phase", "apply", "--baseline", "a".repeat(64)])).toThrow();
    expect(() => parseOptions([...base, "--phase", "rehearsal"])).toThrow();
  });
  it("refuses a public artifact directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-test-"));
    try { chmodSync(dir, 0o755); expect(() => assertPrivateDirectory(join(dir, "backup.dump"))).toThrow(); chmodSync(dir, 0o700); expect(() => assertPrivateDirectory(join(dir, "backup.dump"))).not.toThrow(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses preexisting target tables or changed prerequisites", () => {
    const state = { prerequisites: { deposit: true }, tables: [], functions: [{ name: "commit_security_deposit_disposition", arguments: "uuid, uuid, bigint, bigint, bigint, text, date, jsonb, text, jsonb" }] };
    expect(() => assertCatalog(state, false)).not.toThrow();
    expect(() => assertCatalog({ ...state, tables: [{ name: "security_deposit_return_attempts" }] }, false)).toThrow();
    expect(() => assertCatalog({ ...state, prerequisites: { deposit: false } }, false)).toThrow();
  });
  it("reports bounded refusals but never passes raw database errors", () => {
    expect(safeErrorMessage(new Error("Owner read policy mismatch"))).toBe("Owner read policy mismatch");
    expect(safeErrorMessage(new Error("password=secret in driver output"))).not.toContain("secret");
  });
  it.each([
    { name: "baseline drift", phase: "rehearsal", before: "b", after: "p", expected: "p", commits: false, writes: false },
    { name: "postflight drift", phase: "apply", before: "a", after: "wrong", expected: "p", commits: false, writes: true },
    { name: "rehearsal", phase: "rehearsal", before: "a", after: "p", expected: "p", commits: false, writes: true },
    { name: "apply", phase: "apply", before: "a", after: "p", expected: "p", commits: true, writes: true },
  ])("handles $name with the required commit boundary", async ({ phase, before, after, expected, commits, writes }) => {
    const calls: string[] = [];
    const client = { query: async (query: string) => { calls.push(query); return { rows: query.includes("pg_try_advisory") ? [{ acquired: true }] : [] }; } };
    const inspect = async (_client: unknown, _migrations: unknown, applied: boolean) => ({ fingerprint: applied ? after : before });
    const work = transaction(client, [{ sql: "MIGRATION", version: "v", name: "n" }], { phase, baseline: "a", postflightHash: expected }, inspect);
    if (before !== "a" || (phase === "apply" && after !== expected)) await expect(work).rejects.toThrow();
    else await expect(work).resolves.toMatchObject({ fingerprint: after });
    expect(calls.includes("MIGRATION")).toBe(writes);
    expect(calls.includes("commit")).toBe(commits);
    expect(calls.includes("rollback")).toBe(!commits);
  });
  it("rolls back a failed lock before any migration executes", async () => {
    const calls: string[] = [];
    const client = { query: async (query: string) => { calls.push(query); return { rows: query.includes("pg_try_advisory") ? [{ acquired: false }] : [] }; } };
    await expect(transaction(client, [{ sql: "danger" }], { phase: "rehearsal", baseline: "a".repeat(64) })).rejects.toThrow("lock unavailable");
    expect(calls).toContain("rollback");
    expect(calls).not.toContain("danger");
  });
});

/**
 * The credential the apply phase opened with is short-lived, and the backup plus the migration
 * transaction spend that life — which is how the staging apply committed its 11 migrations and
 * then exited 1 on its OWN verification connection. The verification mints a fresh credential
 * for the same confirmed target, and a transport failure there is reported as
 * committed-but-unverified, never as a failed apply and never as a reason to retry.
 */
describe("committed postflight verification", () => {
  const migrations = [{ sql: "MIGRATION", version: "v", name: "n" }];
  const stubClient = () => {
    const client = { ended: false, end: async () => { client.ended = true; } };
    return client;
  };

  it("mints a fresh credential for the exact confirmed target before reconnecting", async () => {
    const minted: string[] = [];
    const client = stubClient();
    const fingerprint = await verifyCommittedPostflight("staging", migrations, "p", {
      credential: (target: string) => { minted.push(target); return { host: `db.${target}.supabase.co` }; },
      connect: async (config: { host: string }) => { expect(config.host).toBe(`db.${ref}.supabase.co`); return client; },
      readOnly: async (_client: unknown, _migrations: unknown, applied: boolean) => ({ fingerprint: applied ? "p" : "a" }),
    });
    expect(minted).toEqual([ref]);
    expect(fingerprint).toBe("p");
    expect(client.ended).toBe(true);
  });

  it("reports committed-but-unverified when the refreshed credential or connection fails", async () => {
    for (const deps of [
      { credential: () => { throw new Error("Credential bootstrap failed"); }, connect: async () => stubClient() },
      { credential: () => ({}), connect: async () => { throw new Error("password=secret timeout"); } },
    ]) {
      await expect(verifyCommittedPostflight("staging", migrations, "p", { ...deps, readOnly: async () => ({ fingerprint: "p" }) }))
        .rejects.toThrow(COMMITTED_UNVERIFIED);
    }
    expect(safeErrorMessage(new Error(COMMITTED_UNVERIFIED))).toBe(COMMITTED_UNVERIFIED);
  });

  it("still names a real divergence, and never reopens the transaction", async () => {
    const client = stubClient();
    const calls: string[] = [];
    await expect(verifyCommittedPostflight("staging", migrations, "p", {
      credential: () => ({}),
      connect: async () => client,
      readOnly: async (_client: unknown, _migrations: unknown, applied: boolean) => { calls.push(applied ? "applied" : "baseline"); return { fingerprint: "drifted" }; },
    })).rejects.toThrow("Committed postflight differs; inspect before retry");
    expect(calls).toEqual(["applied"]);
    expect(client.ended).toBe(true);
  });
});

describe("postflight drift", () => {
  function validCatalog() {
    const owned = ["resident_identity_subjects", "resident_identity_inquiries", "resident_identity_webhook_events", "resident_identity_manual_reviews", "resident_evidence_policies", "security_deposit_return_attempts"];
    const tables = [...owned, "security_deposit_unmatched_refunds"].map(name => ({ name, rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: name.startsWith("resident_"), auth_insert: false, auth_update: false, auth_delete: false, auth_truncate: false, auth_references: false, auth_trigger: false, anon_truncate: false, anon_references: false, anon_trigger: false, service_truncate: true, service_references: true, service_trigger: true, service_select: true, service_insert: true, service_update: true, service_delete: true }));
    const signatures = [
      ["commit_security_deposit_disposition", "uuid, uuid, bigint, bigint, bigint, text, date, jsonb, text, jsonb"],
      ["commit_security_deposit_disposition_unreserved", "uuid, uuid, bigint, bigint, bigint, text, date, jsonb, text, jsonb"],
      ["reserve_security_deposit_return", "uuid, uuid, text, text, bigint, bigint, bigint, jsonb"], ["settle_security_deposit_return", "uuid"],
      ["bind_security_deposit_refund", "uuid, text, text, bigint, text"], ["bind_security_deposit_refund", "uuid, text, text, bigint, text, uuid"],
      ["reconcile_external_security_deposit_refund", "text, text"], ["apply_resident_identity_event", "text, text, uuid, text, timestamp with time zone, text"],
      ["retry_expired_resident_identity", "uuid"], ["prevent_resident_evidence_policy_update", ""],
    ];
    const functions = signatures.map(([name, args]) => ({ name, arguments: args, security_definer: true, anon_execute: false, auth_execute: false, service_execute: name !== "commit_security_deposit_disposition_unreserved" && !(name === "bind_security_deposit_refund" && args === "uuid, text, text, bigint, text"), config: "{search_path=public}" }));
    const policies = [
      ["resident_identity_subjects", "resident_identity_subject_owner_read"], ["resident_identity_inquiries", "resident_identity_inquiry_owner_read"],
      ["resident_identity_webhook_events", "resident_identity_event_owner_read"], ["resident_identity_manual_reviews", "resident_identity_review_owner_read"],
      ["resident_evidence_policies", "resident_evidence_policy_owner_read"],
    ].map(([table_name,name]) => ({ table_name,name,cmd:"SELECT",roles:"{authenticated}",permissive:"PERMISSIVE",with_check:null,qual: table_name === "resident_evidence_policies" ? "(EXISTS ( SELECT 1 FROM manager_property_records p WHERE ((p.id = resident_evidence_policies.property_id) AND (p.manager_user_id = auth.uid()))))" : "(resident_user_id = auth.uid())" }));
    const triggers = owned.flatMap(table_name => [["account_recovery_write_guard",31],["account_recovery_capture_delete",9]].map(([name,type]) => ({ table_name,name,type,enabled:"O",nargs:0,attributes:"",unqualified:true,unconstrained:true,function_name:name,function_schema:"public" })));
    triggers.push({ table_name:"resident_evidence_policies",name:"resident_evidence_policy_immutable",type:19,enabled:"O",nargs:0,attributes:"",unqualified:true,unconstrained:true,function_name:"prevent_resident_evidence_policy_update",function_schema:"public" });
    return { prerequisites: { deposit:true }, tables, functions, policies, triggers };
  }
  it("refuses privilege, signature, policy and trigger drift", () => {
    const state=validCatalog(); expect(() => assertCatalog(state,true)).not.toThrow();
    for (const mutate of [
      (s: ReturnType<typeof validCatalog>) => { s.tables[0].service_delete=false; },
      (s: ReturnType<typeof validCatalog>) => { s.tables[0].anon_truncate=true; },
      (s: ReturnType<typeof validCatalog>) => { s.tables[0].auth_references=true; },
      (s: ReturnType<typeof validCatalog>) => { s.tables[0].service_trigger=false; },
      (s: ReturnType<typeof validCatalog>) => { s.functions[0].auth_execute=true; },
      (s: ReturnType<typeof validCatalog>) => { s.functions[0].arguments="wrong"; },
      (s: ReturnType<typeof validCatalog>) => { s.policies[0].qual="true"; },
      (s: ReturnType<typeof validCatalog>) => { s.triggers[0].enabled="D"; },
      (s: ReturnType<typeof validCatalog>) => { s.triggers.at(-1)!.type=9; },
    ]) { const changed=structuredClone(state); mutate(changed); expect(() => assertCatalog(changed,true)).toThrow(); }
  });
});
