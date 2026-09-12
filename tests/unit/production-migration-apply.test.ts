import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildAtomicBundle,
  buildCredentialAcquisition,
  executeApprovedProductionApply,
  expectedRecoveryCatalog,
  inspectAppliedState,
  parseProductionOperationArgs,
  readRecoveryCatalog,
  reviewedMigrationManifest,
  validateRecoveryCatalog,
} from "../../scripts/prepare-20260911-production-migrations.mjs";

const WAIVER = "2026-09-11-production-recovery-schema";
const DIGEST = "9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab";
const PROJECT = "qahnczmilgptcedaqype";
const BUNDLE_VERSION = "20260911010000";
const BUNDLE_NAME = "production_recovery_schema";
const APPLY_ARGS = ["--apply", "--waiver", WAIVER, "--bundle-sha256", DIGEST];
const PREFLIGHT_ARGS = ["--preflight", "--waiver", WAIVER, "--bundle-sha256", DIGEST];
const manifest = reviewedMigrationManifest();
const bundle = buildAtomicBundle();
const historicalLedger = [
  { version: "20260821090000", name: "agent_pending_actions", statements: ["historical bytes A"] },
  { version: "20260821100000", name: "agent_pending_actions", statements: ["historical bytes B"] },
];

function login(host = "aws-0-us-west-2.pooler.supabase.com", user = `cli_login_postgres.${PROJECT}`) {
  return `export PGHOST="${host}"\nexport PGPORT="5432"\nexport PGUSER="${user}"\nexport PGPASSWORD="synthetic-private-secret"\nexport PGDATABASE="postgres"`;
}

function ledgerForInstall() {
  return [
    ...historicalLedger,
    ...manifest.map(({ version, name, sql }) => ({ version, name, statements: [sql] })),
    { version: BUNDLE_VERSION, name: BUNDLE_NAME, statements: [bundle] },
  ];
}

function triggerRows(catalog: ReturnType<typeof expectedRecoveryCatalog>) {
  const rows = [];
  const push = (relation: string, tgname: string, timing: string, events: string[], functionIdentity: string,
    update_columns: string[] = [], when_expression: string | null = null, schema = "public") =>
    rows.push({ schema, relation, tgname, tgenabled: "O", timing, for_each: "ROW", events, update_columns, when_expression, function_identity: functionIdentity });
  push("ordinary_fixture", "account_recovery_write_guard", "BEFORE", ["INSERT", "UPDATE", "DELETE"], "public.account_recovery_write_guard()");
  push("ordinary_fixture", "account_recovery_capture_delete", "AFTER", ["DELETE"], "public.account_recovery_capture_delete()");
  for (const relation of ["ledger_entries", "security_deposit_ledger", "manager_payment_plans",
    "portal_household_charge_records", "portal_lease_pipeline_records", "vendor_invoices", "vendor_payouts"]) {
    push(relation, "account_guard_deleted_financial_identity", "BEFORE", ["INSERT", "UPDATE"],
      "public.account_guard_deleted_financial_identity()");
  }
  push("account_recovery_holds", "account_recovery_inherit_file_holds", "AFTER", ["INSERT", "UPDATE"],
    "public.account_recovery_inherit_file_holds()");
  push("users", "account_recovery_auth_identity_guard", "BEFORE", ["UPDATE", "DELETE"],
    "public.account_recovery_auth_identity_guard()", ["email"], null, "auth");
  push("objects", "account_recovery_storage_guard", "BEFORE", ["INSERT", "UPDATE"],
    "public.account_recovery_storage_guard()", [], null, "storage");
  expect(catalog.triggerNames).toContain("account_recovery_auth_identity_guard");
  return rows;
}

function tableRows(catalog: ReturnType<typeof expectedRecoveryCatalog>, badGrant = false) {
  return catalog.tables.map((relname) => ({
    relname,
    relrowsecurity: true,
    policy_count: 0,
    service_select: true,
    service_insert: true,
    service_update: true,
    service_delete: true,
    service_truncate: true,
    service_references: true,
    service_trigger: true,
    anon_select: relname.startsWith("webhook_"),
    anon_insert: badGrant,
    anon_update: false,
    anon_delete: false,
    anon_truncate: relname.startsWith("webhook_"),
    anon_references: relname.startsWith("webhook_"),
    anon_trigger: relname.startsWith("webhook_"),
    authenticated_select: relname.startsWith("webhook_"),
    authenticated_insert: false,
    authenticated_update: false,
    authenticated_delete: false,
    authenticated_truncate: relname.startsWith("webhook_"),
    authenticated_references: relname.startsWith("webhook_"),
    authenticated_trigger: relname.startsWith("webhook_"),
  }));
}

function completeCatalog(overrides: Record<string, unknown> = {}) {
  const expected = expectedRecoveryCatalog();
  const functionRows = expected.functionIdentities.map((identity) => {
    const open = identity.indexOf("(");
    return {
      proname: identity.slice("public.".length, open),
      identity_arguments: identity.slice(open + 1, -1),
      service_execute: true,
      anon_execute: false,
      authenticated_execute: false,
    };
  });
  return {
    ledger: ledgerForInstall(),
    prerequisitesMissing: 0,
    bucket: [{ public: false }],
    expected,
    tableRows: tableRows(expected),
    functionRows,
    guardedPublicTables: ["ordinary_fixture"],
    triggerRows: triggerRows(expected),
    financial: ["vendor_invoices", "vendor_payouts"].flatMap((relation) => [
      { relation, attname: "manager_user_id", attnotnull: false, confdeltype: "n", referenced_relation: "auth.users", referenced_columns: ["id"] },
      { relation, attname: "vendor_user_id", attnotnull: false, confdeltype: "n", referenced_relation: "auth.users", referenced_columns: ["id"] },
    ]),
    auditActor: [{ attnotnull: false }],
    ...overrides,
  };
}

type FailurePoint = "bundle" | "auxiliary" | "precommit";
type State = "clean" | "installed" | "partial" | "approved_version_conflict" | "approved_name_conflict" |
  "auxiliary_version_conflict" | "auxiliary_name_conflict" | "bucket" | "missing_prerequisite" | "bad_catalog";

function initialState(state: State) {
  if (state === "installed") return completeCatalog();
  if (state === "partial") return completeCatalog({
    ledger: [...historicalLedger, { version: manifest[0].version, name: manifest[0].name, statements: [manifest[0].sql] }],
    bucket: [], tableRows: [], functionRows: [], triggerRows: [],
  });
  if (state === "approved_version_conflict") return completeCatalog({
    ledger: [...historicalLedger, { version: manifest[0].version, name: "different_name", statements: ["conflict"] }],
    bucket: [], tableRows: [], functionRows: [], triggerRows: [],
  });
  if (state === "approved_name_conflict") return completeCatalog({
    ledger: [...historicalLedger, { version: "20260101000000", name: manifest[0].name, statements: ["conflict"] }],
    bucket: [], tableRows: [], functionRows: [], triggerRows: [],
  });
  if (state === "auxiliary_version_conflict") return completeCatalog({
    ledger: [...historicalLedger, { version: BUNDLE_VERSION, name: "different_auxiliary", statements: ["conflict"] }],
    bucket: [], tableRows: [], functionRows: [], triggerRows: [],
  });
  if (state === "auxiliary_name_conflict") return completeCatalog({
    ledger: [...historicalLedger, { version: "20260101000000", name: BUNDLE_NAME, statements: ["conflict"] }],
    bucket: [], tableRows: [], functionRows: [], triggerRows: [],
  });
  if (state === "bucket") return completeCatalog({ bucket: [{ public: true }], tableRows: [], functionRows: [], triggerRows: [] });
  if (state === "missing_prerequisite") return completeCatalog({ prerequisitesMissing: 1, bucket: [], tableRows: [], functionRows: [], triggerRows: [] });
  return completeCatalog({ ledger: historicalLedger, bucket: [], tableRows: [], functionRows: [], triggerRows: [] });
}

function queryResult(sql: string, values: unknown[] | undefined, state: ReturnType<typeof completeCatalog>) {
  if (sql.startsWith("select version, name, statements")) return { rows: state.ledger };
  if (sql.startsWith("select count(*)::int as missing")) return { rows: [{ missing: state.prerequisitesMissing }] };
  if (sql.startsWith("select public from storage.buckets")) return { rows: state.bucket };
  if (sql.includes("from pg_class where relnamespace='public'::regnamespace")) return { rows: state.tableRows };
  if (sql.includes("from pg_proc p join pg_namespace")) return { rows: state.functionRows };
  if (sql.startsWith("select tablename from pg_tables")) return { rows: state.guardedPublicTables.map((tablename) => ({ tablename })) };
  if (sql.includes("from pg_trigger t join pg_class")) return { rows: state.triggerRows };
  if (sql.startsWith("select a.attrelid::regclass")) return { rows: state.financial };
  if (sql.startsWith("select attnotnull from pg_attribute")) return { rows: state.auditActor };
  if (sql.includes("from pg_stat_activity")) return { rows: [{ other_sessions: 0, active_sessions: 0, long_transactions: 0, lock_waiters: 0 }] };
  if (sql.startsWith("select pg_advisory")) return { rows: [] };
  void values;
  return { rows: [] };
}

function databaseFactory({
  initial = "clean" as State,
  fresh = "installed" as "clean" | "installed" | "bad_catalog",
  failurePoint,
  commitError = false,
  asyncError = false,
  drift = false,
  queryError = false,
}: {
  initial?: State;
  fresh?: "clean" | "installed" | "bad_catalog";
  failurePoint?: FailurePoint;
  commitError?: boolean;
  asyncError?: boolean;
  drift?: boolean;
  queryError?: boolean;
} = {}) {
  let index = 0;
  const clients: Array<{ connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; calls: string[] }> = [];
  const createClient = vi.fn(() => {
    const clientIndex = index++;
    const emitter = new EventEmitter();
    const before = initialState(clientIndex === 0 ? initial : fresh);
    let installed = clientIndex > 0 && fresh === "installed";
    let ledgerReads = 0;
    let bundleExecuted = false;
    let auxiliaryExecuted = false;
    const calls: string[] = [];
    const connect = vi.fn(async () => {
      if (asyncError) queueMicrotask(() => emitter.emit("error", new Error("async pg secret synthetic-private-secret")));
    });
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (queryError && sql.startsWith("select version, name, statements")) throw new Error("query leaked synthetic-private-secret");
      if (sql.startsWith("select version, name, statements")) {
        if (failurePoint === "precommit" && bundleExecuted && auxiliaryExecuted) {
          throw new Error("precommit synthetic-private-secret");
        }
        ledgerReads += 1;
        if (drift && clientIndex === 0 && ledgerReads === 2) {
          return { rows: [...historicalLedger, { version: "20260821110000", name: "concurrent_change", statements: ["changed"] }] };
        }
        if (!installed) return { rows: before.ledger };
        return { rows: ledgerForInstall() };
      }
      if (sql === bundle) {
        if (failurePoint === "bundle") throw new Error("bundle execution synthetic-private-secret");
        bundleExecuted = true;
        installed = true;
        return { rows: [] };
      }
      if (sql.startsWith("insert into supabase_migrations.schema_migrations")) {
        if (failurePoint === "auxiliary") throw new Error("auxiliary execution synthetic-private-secret");
        auxiliaryExecuted = true;
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        if (commitError) throw new Error("lost COMMIT response synthetic-private-secret");
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (!commitError) installed = false;
        return { rows: [] };
      }
      if (clientIndex > 0 && fresh === "bad_catalog") return queryResult(sql, values, { ...completeCatalog(), bucket: [{ public: true }] });
      if (clientIndex === 0 && installed) return queryResult(sql, values, completeCatalog());
      return queryResult(sql, values, before);
    });
    const end = vi.fn(async () => undefined);
    const client = { connect, query, end, on: emitter.on.bind(emitter) };
    clients.push({ connect, query, end, calls });
    return client;
  });
  return { createClient, clients };
}

function credentialCli(output = login()) {
  const calls: string[][] = [];
  const runCli = vi.fn((args: string[]) => {
    calls.push(args);
    return { status: 0, signal: null, timedOut: false, output };
  });
  return { runCli, calls };
}

describe("approved production operation boundary", () => {
  it("accepts only the exact apply and read-only preflight acknowledgements", () => {
    expect(parseProductionOperationArgs(APPLY_ARGS)).toEqual({ apply: true, operation: "apply" });
    expect(parseProductionOperationArgs(PREFLIGHT_ARGS)).toEqual({ apply: true, operation: "preflight" });
    for (const args of [[], ["--apply"], ["--preflight"], [...APPLY_ARGS, "--apply"],
      [...APPLY_ARGS, "--sql", "select 1"], ["--apply", "--preflight", ...APPLY_ARGS.slice(1)],
      ["--apply", "--waiver", "wrong", "--bundle-sha256", DIGEST]]) expect(() => parseProductionOperationArgs(args)).toThrow();
  });

  it("preserves the unchanged source bundle and exact fingerprint", () => {
    expect(Buffer.byteLength(bundle)).toBe(215925);
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(DIGEST);
    expect(bundle).toBe(buildAtomicBundle());
    expect(manifest).toHaveLength(12);
    expect(bundle.match(/-- exact source:/g)).toHaveLength(12);
  });

  it("allows unrelated historical duplicate names but rejects duplicate versions and approved identities", () => {
    expect(inspectAppliedState(historicalLedger.map(({ version, name }) => ({ version, name }))).status).toBe("ready");
    expect(inspectAppliedState([
      ...historicalLedger.map(({ version, name }) => ({ version, name })),
      { version: historicalLedger[0].version, name: "different" },
    ]).status).toBe("conflict");
    expect(inspectAppliedState([{ version: manifest[0].version, name: "different" }]).status).toBe("conflict");
    expect(inspectAppliedState([{ version: "20260101000000", name: manifest[0].name }]).status).toBe("conflict");
  });

  it("builds a private minimal child environment and proves the actual child sees only it", () => {
    const root = mkdtempSync(join(tmpdir(), "production-credential-test-"));
    const invocation = buildCredentialAcquisition({
      environment: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
        SUPABASE_DB_URL: "postgresql://secret@wrong", PGHOST: "wrong", PGSSLMODE: "disable", NODE_OPTIONS: "--require evil" },
      makeTemp: () => root,
    });
    expect(invocation.file).toBe("npx");
    expect(invocation.args).toEqual(["-y", "supabase@2.117.0", "db", "dump", "--project-ref", PROJECT,
      "--data-only", "--schema", "public", "--dry-run", "--yes"]);
    expect(invocation.cwd).toBe(root);
    expect((statSync(root).mode & 0o777)).toBe(0o700);
    expect(readdirSync(root)).toEqual(["supabase"]);
    expect(Object.keys(invocation.env).sort()).toEqual(["HOME", "PATH", "USER"]);
    expect(invocation.env).not.toHaveProperty("PGHOST");
    const observed = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({cwd:process.cwd(),keys:Object.keys(process.env).sort()}))"],
      { cwd: invocation.cwd, env: invocation.env, encoding: "utf8" });
    expect(observed.status).toBe(0);
    const observedChild = JSON.parse(observed.stdout);
    expect(observedChild.cwd).toBe(realpathSync(root));
    expect(observedChild.keys).toEqual(expect.arrayContaining(["HOME", "PATH", "USER"]));
    expect(observedChild.keys).not.toEqual(expect.arrayContaining(["PGHOST", "PGSSLMODE", "NODE_OPTIONS", "SUPABASE_DB_URL"]));
    expect(readFileSync(join(root, "supabase", "config.toml"), "utf8")).toBe('project_id = "production-migration-login"\n');
    chmodSync(root, 0o700);
  });
});

describe("verified PostgreSQL runner", () => {
  it("uses the CLI only for read-only credential acquisition and preflight performs zero writes", async () => {
    const database = databaseFactory({ fresh: "clean" });
    const cli = credentialCli();
    await expect(executeApprovedProductionApply({ operation: "preflight", runCli: cli.runCli, createClient: database.createClient }))
      .resolves.toEqual({ outcome: "preflight_passed", migrationCount: 12, ledgerRows: 2,
        prerequisitesMissing: 0, targetObjectsAbsent: true,
        activity: { other_sessions: 0, active_sessions: 0, long_transactions: 0, lock_waiters: 0 } });
    expect(cli.calls).toEqual([["db", "dump", "--project-ref", PROJECT, "--data-only", "--schema", "public", "--dry-run", "--yes"]]);
    expect(cli.calls.flat()).not.toContain("push");
    expect(database.clients[0].calls).not.toContain(bundle);
    expect(database.clients[0].calls.every((sql) => !sql.startsWith("insert ") && !sql.startsWith("create ") && sql !== "COMMIT"))
      .toBe(true);
  });

  it("installs cleanly in one verified transaction and preserves the complete historical ledger", async () => {
    const database = databaseFactory();
    const cli = credentialCli();
    await expect(executeApprovedProductionApply({ runCli: cli.runCli, createClient: database.createClient }))
      .resolves.toEqual({ outcome: "success", migrationCount: 12 });
    const calls = database.clients[0].calls;
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("SET LOCAL ROLE postgres");
    expect(calls).toContain(bundle);
    expect(calls.filter((sql) => sql.startsWith("insert into supabase_migrations.schema_migrations"))).toHaveLength(1);
    const auxiliary = database.clients[0].query.mock.calls.find(([sql]) => sql.startsWith("insert into supabase_migrations.schema_migrations"));
    expect(auxiliary?.[1]).toEqual([BUNDLE_VERSION, BUNDLE_NAME, bundle]);
    expect(calls).toContain("COMMIT");
    expect(database.createClient).toHaveBeenCalledTimes(2);
    expect(validateRecoveryCatalog(completeCatalog(), { historicalLedger })).toBe(true);
    expect(ledgerForInstall()).toHaveLength(15);
    expect(ledgerForInstall().filter(({ name }) => name === "agent_pending_actions")).toHaveLength(2);
    expect(ledgerForInstall().at(-1)).toEqual({ version: BUNDLE_VERSION, name: BUNDLE_NAME, statements: [bundle] });
  });

  it.each([
    ["partial", "partial"], ["already installed", "installed"], ["approved version conflict", "approved_version_conflict"],
    ["approved name conflict", "approved_name_conflict"], ["auxiliary version conflict", "auxiliary_version_conflict"],
    ["auxiliary name conflict", "auxiliary_name_conflict"], ["bucket conflict", "bucket"], ["missing prerequisite", "missing_prerequisite"],
  ] as const)("rejects %s before any apply transaction", async (_label, state) => {
    const database = databaseFactory({ initial: state });
    const cli = credentialCli();
    await expect(executeApprovedProductionApply({ runCli: cli.runCli, createClient: database.createClient })).rejects.toThrow(/preflight validation/);
    expect(database.createClient).toHaveBeenCalledTimes(1);
    expect(database.clients[0].calls).not.toContain(bundle);
    expect(database.clients[0].calls).not.toContain("COMMIT");
  });

  it("rejects a changed full historical ledger before applying", async () => {
    const database = databaseFactory({ drift: true });
    const cli = credentialCli();
    await expect(executeApprovedProductionApply({ runCli: cli.runCli, createClient: database.createClient })).rejects.toThrow(/ledger drift validation/);
    expect(database.clients[0].calls).not.toContain(bundle);
  });

  it.each(["bundle", "auxiliary", "precommit"] as FailurePoint[])("confirms rollback when failure occurs at %s", async (failurePoint) => {
    const database = databaseFactory({ failurePoint, fresh: "clean" });
    const cli = credentialCli();
    await expect(executeApprovedProductionApply({ runCli: cli.runCli, createClient: database.createClient }))
      .resolves.toMatchObject({ outcome: "rolled_back_or_refused" });
    expect(database.clients[0].calls).toContain("ROLLBACK");
    expect(database.clients[0].calls).not.toContain("COMMIT");
    expect(database.createClient).toHaveBeenCalledTimes(2);
  });

  it("keeps a lost COMMIT response uncertain and never retries", async () => {
    const database = databaseFactory({ commitError: true, fresh: "installed" });
    const cli = credentialCli();
    await expect(executeApprovedProductionApply({ runCli: cli.runCli, createClient: database.createClient }))
      .resolves.toMatchObject({ outcome: "uncertain_or_partial" });
    expect(database.clients[0].calls.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    const commitIndex = database.clients[0].calls.indexOf("COMMIT");
    expect(database.clients[0].calls.slice(commitIndex + 1)).not.toContain("ROLLBACK");
    expect(database.createClient).toHaveBeenCalledTimes(2);
  });

  it("registers async driver errors before connect and redacts synchronous driver errors", async () => {
    const asyncDatabase = databaseFactory({ asyncError: true });
    await expect(executeApprovedProductionApply({ runCli: credentialCli().runCli, createClient: asyncDatabase.createClient }))
      .rejects.toThrow(/No credentials, SQL, or database output is displayed/);
    const errorDatabase = databaseFactory({ queryError: true });
    await expect(executeApprovedProductionApply({ runCli: credentialCli().runCli, createClient: errorDatabase.createClient }))
      .rejects.toThrow(/No credentials, SQL, or database output is displayed/);
  });

  it("rejects certificate failure and hostname mismatch without opening an alternate target", async () => {
    const createClient = vi.fn(() => ({
      connect: vi.fn(async () => { throw new Error("self-signed certificate synthetic-private-secret"); }),
      query: vi.fn(), end: vi.fn(async () => undefined), on: vi.fn(),
    }));
    await expect(executeApprovedProductionApply({ runCli: credentialCli().runCli, createClient }))
      .rejects.toThrow(/No credentials, SQL, or database output is displayed/);
    expect(createClient.mock.calls[0][0].ssl).toMatchObject({ rejectUnauthorized: true, servername: "aws-0-us-west-2.pooler.supabase.com" });
    const alternate = vi.fn();
    await expect(executeApprovedProductionApply({ runCli: credentialCli(login("evil.pooler.supabase.com.evil.test")).runCli, createClient: alternate }))
      .rejects.toThrow(/credential binding validation/);
    expect(alternate).not.toHaveBeenCalled();
  });
});

describe("catalog validator", () => {
  it("requires byte-exact source and auxiliary statements, exact overloads, trigger topology, and nullable auth FKs", () => {
    const valid = completeCatalog();
    expect(validateRecoveryCatalog(valid, { historicalLedger })).toBe(true);
    const cases = [
      () => ({ ...valid, ledger: valid.ledger.map((row, i) => i === 0 ? { ...row, statements: ["changed"] } : row) }),
      () => ({ ...valid, ledger: valid.ledger.map((row) => row.version === BUNDLE_VERSION ? { ...row, statements: ["changed"] } : row) }),
      () => ({ ...valid, functionRows: valid.functionRows.map((row, i) => i === 0 ? { ...row, identity_arguments: "wrong_overload" } : row) }),
      () => ({ ...valid, triggerRows: valid.triggerRows.map((row, i) => i === 0 ? { ...row, relation: "wrong_relation" } : row) }),
      () => ({ ...valid, financial: valid.financial.map((row, i) => i === 0 ? { ...row, referenced_relation: "public.profiles" } : row) }),
      () => ({ ...valid, tableRows: valid.tableRows.map((row, i) => i === 0 ? { ...row, anon_insert: true } : row) }),
    ];
    for (const makeInvalid of cases) expect(() => validateRecoveryCatalog(makeInvalid(), { historicalLedger })).toThrow(/post-apply catalog verification/);
  });

  it("uses read-only transactions for the narrow catalog reader", async () => {
    const state = completeCatalog();
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => { calls.push(sql); return queryResult(sql, undefined, state); }),
    };
    await expect(readRecoveryCatalog(client, manifest, { readOnly: true })).resolves.toMatchObject({ ledger: ledgerForInstall() });
    expect(calls[0]).toBe("BEGIN READ ONLY");
    expect(calls[1]).toBe("SET LOCAL ROLE postgres");
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(calls).not.toContain(bundle);
  });
});
