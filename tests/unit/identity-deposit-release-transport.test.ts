import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCatalog, assertPrivateDirectory, parseOptions, transaction, safeErrorMessage, verifyCommittedPostflight, refreshAfterBackup, readLedgerStateReadOnly, COMMITTED_UNVERIFIED } from "../../scripts/identity-deposit-release-migrations.mjs";
import { IDENTITY_DEPOSIT_ENTRIES, IDENTITY_DEPOSIT_COMMITTED_PREFIX, identityDepositLedgerState, reviewedIdentityDepositMigrations } from "../../scripts/identity-deposit-release-manifest.mjs";
import { sha256 } from "../../scripts/sms-durability-release-manifest.mjs";

const ref = "xwszcafaontidfgznlxd";
const base = ["--target", "staging", "--confirm-ref", ref];
describe("release transport refusal", () => {
  it("reads the initial ledger under a read-only local postgres role and rolls back", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; } };
    await readLedgerStateReadOnly(client, []);
    expect(calls[0]).toBe("begin read only");
    expect(calls[1]).toBe("set local role postgres");
    expect(calls[2]).toContain("supabase_migrations.schema_migrations");
    expect(calls[3]).toBe("rollback");
  });
  it("rolls back the role transaction when ledger access fails", async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql); if (sql.includes("schema_migrations")) throw new Error("denied"); return { rows: [] }; } };
    await expect(readLedgerStateReadOnly(client, [])).rejects.toThrow("denied");
    expect(calls.at(-1)).toBe("rollback");
  });
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
    const inspect = async (_client: unknown, _migrations: unknown, expected: string) => ({ fingerprint: expected === "complete" ? after : before });
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
      readOnly: async (_client: unknown, _migrations: unknown, expected: string) => ({ fingerprint: expected === "complete" ? "p" : "a" }),
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
      readOnly: async (_client: unknown, _migrations: unknown, expected: string) => { calls.push(expected); return { fingerprint: "drifted" }; },
    })).rejects.toThrow("Committed postflight differs; inspect before retry");
    expect(calls).toEqual(["complete"]);
    expect(client.ended).toBe(true);
  });

  it("preserves bounded ledger divergence diagnostics after commit", async () => {
    const client = stubClient();
    await expect(verifyCommittedPostflight("staging", migrations, "p", {
      credential: () => ({}), connect: async () => client,
      readOnly: async () => { throw new Error("Migration ledger differs: 20261108140000"); },
    })).rejects.toThrow("Migration ledger differs: 20261108140000");
  });

  it("replaces an expired backup connection before any transaction", async () => {
    const old = stubClient();
    const fresh = stubClient();
    const calls: string[] = [];
    const result = await refreshAfterBackup("staging", old, {
      credential: (target: string) => { calls.push(target); return { target }; },
      connect: async (config: { target: string }) => { expect(old.ended).toBe(true); expect(config.target).toBe(ref); return fresh; },
    });
    expect(result).toBe(fresh);
    expect(calls).toEqual([ref]);
  });
  it("does not reach a transaction when the refreshed connection fails", async () => {
    const old = stubClient();
    await expect(refreshAfterBackup("staging", old, {
      credential: () => ({}), connect: async () => { throw new Error("offline"); },
    })).rejects.toThrow("offline");
    expect(old.ended).toBe(true);
  });
});

/**
 * Three reviewed ledger states and nothing else. Production holds none of this manifest,
 * staging and dev hold exactly the first eleven, and all twelve is postflight-only. A hole, a
 * foreign prefix, a duplicate or a changed statement is a refusal — never a state to apply from.
 */
describe("reviewed 0/11/12 ledger transport", () => {
  const migrations = reviewedIdentityDepositMigrations();
  const entry = (migration: { version: string; name: string; sql: string }) =>
    ({ version: migration.version, name: migration.name, statements: [migration.sql] });

  it("adds exactly one migration after the committed eleven, and keeps their checksums", () => {
    expect(migrations).toHaveLength(IDENTITY_DEPOSIT_COMMITTED_PREFIX + 1);
    expect(IDENTITY_DEPOSIT_ENTRIES.slice(0, IDENTITY_DEPOSIT_COMMITTED_PREFIX).map(([, , hash]) => hash)).toEqual([
      "129ecc11d4d6ca73af0ddce16964d7013373d0cc6671796453b1969073925e72",
      "3af081368b19baf2dfd7e32f73b0786fae041c1c8614c68b9fd6a9ac1506d717",
      "db74785a8bce3324510a9575fc9bbe69e122b152df381604a34a672d6e9b13af",
      "47735f77b71ca874e95f6d9751bf75d94c0636462b495662e978bb5f9ce6271f",
      "b57f0b014056a33f71044d6a6fe52c85e332df49023d6afcd34d73fb0179e1f1",
      "6afde71ffff91fafff5155b8e97dde5c1a5293ea8d76b14dcd53b38cc20c5b1a",
      "dde862efb29dd9594f3f515e6901ad6fce872f7bacc54793f8bf47dfb2f6fe4c",
      "a84d45b35b58dfe77f6340ce4ae61a528f77edcc73b8ed643173ffaa8581d7c3",
      "a0a031afd9d1416c7835f7d67eaf73165770212b68d74599c2f938c69cc075be",
      "1f62ec00ff11b39fa8b4affef27fddc161c3c8c31a4a9e87411d9480a983adba",
      "d855c3bed7ad146d3b99e43897b3f36bd44ed4a9de4a3a1b6f2420a3c23a1188",
    ]);
    expect(sha256(migrations.at(-1)!.sql)).toBe(IDENTITY_DEPOSIT_ENTRIES.at(-1)![2]);
  });

  it("reads absent, the exact eleven-prefix and complete, and nothing else", () => {
    expect(identityDepositLedgerState([], migrations)).toMatchObject({ kind: "absent", applied: 0 });
    const prefix = migrations.slice(0, IDENTITY_DEPOSIT_COMMITTED_PREFIX).map(entry);
    expect(identityDepositLedgerState(prefix, migrations)).toMatchObject({ kind: "prefix", applied: 11 });
    expect(identityDepositLedgerState(prefix, migrations).pending.map((m: { version: string }) => m.version))
      .toEqual(["20261108140000"]);
    expect(identityDepositLedgerState(migrations.map(entry), migrations)).toMatchObject({ kind: "complete", applied: 12 });
  });

  it("refuses a hole, a short prefix, a renamed apply version and a changed statement", () => {
    const full = migrations.map(entry);
    // A hole: the twelfth present while the eleventh is not.
    expect(() => identityDepositLedgerState([...full.slice(0, 10), full[11]], migrations)).toThrow(/Migration ledger differs/);
    // Any prefix other than the reviewed eleven.
    expect(() => identityDepositLedgerState(full.slice(0, 4), migrations)).toThrow(/Migration ledger differs/);
    // A renamed version keeping the reviewed name.
    expect(() => identityDepositLedgerState(
      [...full.slice(0, 10), { ...full[10], version: "20261108139999" }], migrations,
    )).toThrow(/Migration ledger differs/);
    // A statement whose hash is not the reviewed one.
    expect(() => identityDepositLedgerState(
      [...full.slice(0, 10), { ...full[10], statements: ["-- edited"] }], migrations,
    )).toThrow(/Migration ledger differs/);
    // Two statements where the reviewed entry has one.
    expect(() => identityDepositLedgerState(
      [...full.slice(0, 10), { ...full[10], statements: [full[10].statements[0], "-- extra"] }], migrations,
    )).toThrow(/Migration ledger differs/);
  });

  it("applies only the pending suffix from the eleven-prefix, and never re-runs the committed DDL", async () => {
    const calls: string[] = [];
    const client = { query: async (query: string) => { calls.push(query); return { rows: query.includes("pg_try_advisory") ? [{ acquired: true }] : [] }; } };
    const inspect = async (_c: unknown, _m: unknown, expected: string) => ({ fingerprint: expected === "complete" ? "p" : "a" });
    await expect(transaction(client, migrations, {
      phase: "apply", baseline: "a", postflightHash: "p",
      before: "prefix", pending: migrations.slice(IDENTITY_DEPOSIT_COMMITTED_PREFIX),
    }, inspect)).resolves.toMatchObject({ fingerprint: "p" });
    const applied = calls.filter((query) => query.startsWith("--") || query.includes("create table if not exists public.household_charge_refund_attempts"));
    expect(applied).toHaveLength(1);
    for (const committed of migrations.slice(0, IDENTITY_DEPOSIT_COMMITTED_PREFIX)) {
      expect(calls).not.toContain(committed.sql);
    }
    expect(calls).toContain("commit");
  });

  it("refuses an apply with nothing pending", async () => {
    const client = { query: async (query: string) => ({ rows: query.includes("pg_try_advisory") ? [{ acquired: true }] : [] }) };
    await expect(transaction(client, migrations, { phase: "apply", baseline: "a", postflightHash: "p", before: "complete", pending: [] },
      async () => ({ fingerprint: "a" }))).rejects.toThrow("Nothing pending for this target");
    expect(safeErrorMessage(new Error("Nothing pending for this target"))).toBe("Nothing pending for this target");
  });
});

describe("postflight drift", () => {
  function validCatalog() {
    const owned = ["resident_identity_subjects", "resident_identity_inquiries", "resident_identity_webhook_events", "resident_identity_manual_reviews", "resident_evidence_policies", "security_deposit_return_attempts", "household_charge_refund_attempts"];
    const tables = [...owned, "security_deposit_unmatched_refunds"].map(name => ({ name, rls: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, auth_select: name.startsWith("resident_"), auth_insert: false, auth_update: false, auth_delete: false, auth_truncate: false, auth_references: false, auth_trigger: false, anon_truncate: false, anon_references: false, anon_trigger: false, service_truncate: true, service_references: true, service_trigger: true, service_select: true, service_insert: true, service_update: true, service_delete: true }));
    const signatures = [
      ["commit_security_deposit_disposition", "uuid, uuid, bigint, bigint, bigint, text, date, jsonb, text, jsonb"],
      ["commit_security_deposit_disposition_unreserved", "uuid, uuid, bigint, bigint, bigint, text, date, jsonb, text, jsonb"],
      ["reserve_security_deposit_return", "uuid, uuid, text, text, bigint, bigint, bigint, jsonb"], ["settle_security_deposit_return", "uuid"],
      ["bind_security_deposit_refund", "uuid, text, text, bigint, text"], ["bind_security_deposit_refund", "uuid, text, text, bigint, text, uuid"],
      ["reconcile_external_security_deposit_refund", "text, text"], ["apply_resident_identity_event", "text, text, uuid, text, timestamp with time zone, text"],
      ["retry_expired_resident_identity", "uuid"], ["prevent_resident_evidence_policy_update", ""],
      ["reserve_household_charge_refund", "uuid, text, text, text, text, text, bigint, jsonb"],
      ["stamp_household_charge_refund_platform_key", "uuid, text"],
      ["bind_household_charge_refund", "uuid, text, text, bigint, text, text, uuid"],
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
  it("refuses the twelfth migration's objects while the ledger says they are still pending", () => {
    const complete = validCatalog();
    expect(() => assertCatalog(complete, "complete")).not.toThrow();
    // `prefix` is staging and dev: the first eleven validate and the twelfth's objects must be
    // ABSENT. A present table is never evidence that its migration ran.
    expect(() => assertCatalog(complete, "prefix")).toThrow("Unexpected existing target schema");
    const prefixOnly = {
      ...complete,
      tables: complete.tables.filter((t) => t.name !== "household_charge_refund_attempts"),
      functions: complete.functions.filter((f) => !f.name.includes("household_charge_refund")),
      triggers: complete.triggers.filter((t) => t.table_name !== "household_charge_refund_attempts"),
    };
    expect(() => assertCatalog(prefixOnly, "prefix")).not.toThrow();
    // The same catalog is NOT a complete one: the twelfth's objects are missing.
    expect(() => assertCatalog(prefixOnly, "complete")).toThrow();
  });

  it("requires both recovery hooks and exact RPC security on the new owned table", () => {
    for (const mutate of [
      (s: ReturnType<typeof validCatalog>) => { s.triggers = s.triggers.filter((t) => !(t.table_name === "household_charge_refund_attempts" && t.name === "account_recovery_capture_delete")); },
      (s: ReturnType<typeof validCatalog>) => { s.triggers = s.triggers.filter((t) => !(t.table_name === "household_charge_refund_attempts" && t.name === "account_recovery_write_guard")); },
      (s: ReturnType<typeof validCatalog>) => { const f = s.functions.find((x) => x.name === "bind_household_charge_refund")!; f.security_definer = false; },
      (s: ReturnType<typeof validCatalog>) => { const f = s.functions.find((x) => x.name === "reserve_household_charge_refund")!; f.auth_execute = true; },
      (s: ReturnType<typeof validCatalog>) => { const f = s.functions.find((x) => x.name === "reserve_household_charge_refund")!; f.config = "{}"; },
      (s: ReturnType<typeof validCatalog>) => { const f = s.functions.find((x) => x.name === "bind_household_charge_refund")!; f.service_execute = false; },
      (s: ReturnType<typeof validCatalog>) => { const t = s.tables.find((x) => x.name === "household_charge_refund_attempts")!; t.auth_select = true; },
      (s: ReturnType<typeof validCatalog>) => { const t = s.tables.find((x) => x.name === "household_charge_refund_attempts")!; t.rls = false; },
    ]) { const changed = structuredClone(validCatalog()); mutate(changed); expect(() => assertCatalog(changed, "complete")).toThrow(); }
  });

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
