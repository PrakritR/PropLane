import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAtomicBundle,
  reviewedMigrationManifest,
} from "../../scripts/prepare-20260911-comms-billing-migrations.mjs";
import {
  connectionFromCli,
  parseArgs,
  runFixedOperation,
} from "../../scripts/apply-20260911-comms-billing-migrations.mjs";

const BUNDLE_SHA256 = "c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff";
const STAGING = "xwszcafaontidfgznlxd";
const PRODUCTION = "qahnczmilgptcedaqype";
const WAIVER = "2026-09-11-production-comms-billing";
const manifest = reviewedMigrationManifest();
const bundle = buildAtomicBundle(manifest);
const historical = [{ version: "20260901000000", name: "historical_fixture", statements: ["unchanged"] }];

const expectedFunctions = [
  ["comms_wallet_snapshot", "uuid,integer,integer,boolean"],
  ["comms_wallet_snapshots", "jsonb"],
  ["reserve_comms_credit", "uuid,integer,integer,text,text,numeric,integer,jsonb,boolean"],
  ["finish_comms_credit", "uuid,text,boolean"],
  ["fulfill_comms_credit_purchase", "uuid,uuid,text,text,integer,text,text"],
  ["reverse_comms_credit_purchase", "text,integer,text,text"],
  ["settle_comms_credit_quantity", "uuid,text,numeric"],
  ["save_manager_payment_preferences", "uuid,jsonb"],
  ["set_staff_payment_fee_override", "uuid,text"],
  ["claim_comms_budget_alert", "uuid"],
  ["spend_sms_outbox_segment_budget", "uuid,text"],
];

function installedLedger() {
  return [
    ...historical,
    ...manifest.map(({ version, name, sql }) => ({ version, name, statements: [sql] })),
    { version: "20260911161000", name: "comms_billing_rollout", statements: [bundle] },
  ];
}

function state(installed: boolean) {
  const recoveryTables = ["manager_comms_credit_adjustments", "manager_comms_credit_purchases"];
  const installedColumns = [
    ["manager_comms_billing_accounts", "credit_cutover_at", "timestamptz", "YES", null],
    ["manager_comms_billing_accounts", "credit_period_start", "timestamptz", "YES", null],
    ["manager_comms_billing_accounts", "included_allowance_cents", "int4", "NO", "0"],
    ["manager_comms_billing_accounts", "included_remaining_cents", "int4", "NO", "0"],
    ["manager_comms_billing_accounts", "purchased_credit_cents", "int4", "NO", "0"],
    ["manager_comms_billing_accounts", "stripe_customer_id", "text", "YES", null],
    ["manager_comms_usage_events", "credit_period_start", "timestamptz", "YES", null],
    ["manager_comms_usage_events", "credit_state", "text", "NO", "'legacy'::text"],
    ["manager_comms_usage_events", "included_debit_cents", "int4", "NO", "0"],
    ["manager_comms_usage_events", "platform_absorbed_cents", "int4", "NO", "0"],
    ["manager_comms_usage_events", "purchased_debit_cents", "int4", "NO", "0"],
    ["sms_outbox", "campaign_budget_spent_on", "date", "YES", null],
  ].map(([table_name, column_name, udt_name, is_nullable, column_default]) => ({ table_name, column_name, udt_name, is_nullable, column_default }));
  return {
    ledger: installed ? installedLedger() : historical,
    prerequisitesMissing: 0,
    columns: installed ? installedColumns : [],
    indexes: installed ? [
      { indexname: "comms_credit_purchases_owner_created", table_name: "manager_comms_credit_purchases", indisunique: false, indisvalid: true, indnkeyatts: 2, indexdef: "CREATE INDEX comms_credit_purchases_owner_created ON public.manager_comms_credit_purchases USING btree (manager_user_id, created_at DESC)", predicate: "" },
      { indexname: "manager_billing_customer_unique", table_name: "manager_comms_billing_accounts", indisunique: true, indisvalid: true, indnkeyatts: 1, indexdef: "CREATE UNIQUE INDEX manager_billing_customer_unique ON public.manager_comms_billing_accounts USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL)", predicate: "(stripe_customer_id IS NOT NULL)" },
    ] : [],
    targets: installed
      ? ["comms_credit_policy", "manager_comms_credit_purchases", "manager_comms_credit_adjustments"].map((relname) => ({ relname, relrowsecurity: true, policies: 0, service_select: true, service_insert: true, service_update: true, service_delete: true, service_column_access: true, anon_select: false, anon_insert: false, anon_update: false, anon_delete: false, anon_column_access: false, authenticated_select: false, authenticated_insert: false, authenticated_update: false, authenticated_delete: false, authenticated_column_access: false }))
      : [],
    functions: installed
      ? expectedFunctions.map(([proname, args]) => ({
          proname,
          args,
          prosecdef: true,
          proconfig: [
            proname === "claim_comms_budget_alert" ? "search_path=public" : "search_path=public, pg_temp",
            ...(["claim_comms_budget_alert", "comms_wallet_snapshot", "comms_wallet_snapshots", "spend_sms_outbox_segment_budget"].includes(proname) ? ["TimeZone=UTC"] : []),
          ],
          service_execute: true,
          anon_execute: false,
          authenticated_execute: false,
        }))
      : [],
    triggers: installed
      ? recoveryTables.flatMap((relname) => [
          { relname, tgname: "account_recovery_capture_delete", fn: "public.account_recovery_capture_delete()", tgtype: 9, tgenabled: "O", update_columns: "", when_clause: null },
          { relname, tgname: "account_recovery_write_guard", fn: "public.account_recovery_write_guard()", tgtype: 31, tgenabled: "O", update_columns: "", when_clause: null },
        ])
      : [],
    shape: installed ? { singleton: 1, policy_rows: 1, credit_defaults: 6 } : null,
    constraints: installed ? [
      { conname: "comms_usage_credit_state_check", definition: "CHECK ((credit_state = ANY (ARRAY['legacy'::text, 'reserved'::text, 'settled'::text, 'released'::text])))" },
      { conname: "manager_comms_usage_events_quantity_check", definition: "CHECK (((quantity > (0)::numeric) OR ((quantity = (0)::numeric) AND (credit_state = 'released'::text))))" },
    ] : [],
    activity: { other_sessions: 0, active_sessions: 0, long_transactions: 0, lock_waiters: 0 },
    recoveryPrerequisites: true,
    manualPayments: { compatible: true, backfill: false },
  };
}

class FakeClient extends EventEmitter {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  phase = "before";
  ended = false;
  constructor(private readonly behavior: { failInterior?: boolean; failCommit?: boolean; asyncError?: boolean; columnLeak?: boolean; wrongIndex?: boolean; wrongIndexKey?: boolean; weakConstraint?: boolean } = {}) { super(); }
  private catalog(installed: boolean) {
    const value = state(installed);
    if (installed && this.behavior.columnLeak) value.targets[0].anon_column_access = true;
    if (installed && this.behavior.wrongIndex) value.indexes[1] = { ...value.indexes[1], indisunique: false };
    if (installed && this.behavior.wrongIndexKey) value.indexes[1] = { ...value.indexes[1], indnkeyatts: 2, indexdef: "CREATE UNIQUE INDEX manager_billing_customer_unique ON public.manager_comms_billing_accounts USING btree (manager_user_id, stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL)" };
    if (installed && this.behavior.weakConstraint) value.constraints[1] = { ...value.constraints[1], definition: "CHECK ((quantity >= (0)::numeric))" };
    return value;
  }
  async connect() {
    if (this.behavior.asyncError) {
      queueMicrotask(() => this.emit("error", new Error("secret driver detail")));
      return;
    }
  }
  async end() { this.ended = true; }
  async query(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    if (sql === "BEGIN" && this.phase === "before") this.phase = "transaction";
    if (sql.startsWith("insert into supabase_migrations.schema_migrations")) this.phase = "before-commit";
    if (sql === "COMMIT") {
      if (this.behavior.failCommit) throw new Error("socket closed after commit");
      this.phase = "committed";
      return { rows: [] };
    }
    if (sql === "ROLLBACK") { this.phase = "rolledback"; return { rows: [] }; }
    if (this.behavior.failInterior && sql.includes("-- exact source:")) throw new Error("secret SQL failure");
    if (sql.startsWith("select version,name,statements")) {
      const installed = this.phase === "committed" || this.phase === "before-commit";
      return { rows: this.catalog(installed).ledger };
    }
    if (sql.includes("from unnest($1::text[])")) return { rows: [{ n: "0" }] };
    if (sql.includes("to_regprocedure('public.spend_sms_segment_budget(integer)')")) return { rows: [{ ok: true }] };
    if (sql.startsWith("select a.attname")) return { rows: [{ compatible: true, backfill: false }] };
    if (sql.includes("from information_schema.columns")) return { rows: this.catalog(this.phase === "committed" || this.phase === "before-commit").columns };
    if (sql.startsWith("select c.relname indexname")) return { rows: this.catalog(this.phase === "committed" || this.phase === "before-commit").indexes };
    if (sql.includes("from pg_class c") && sql.includes("relname=any")) return { rows: this.catalog(this.phase === "committed" || this.phase === "before-commit").targets };
    if (sql.includes("from pg_proc p") && sql.includes("p.proname=any")) return { rows: this.catalog(this.phase === "committed" || this.phase === "before-commit").functions };
    if (sql.includes("from pg_trigger t")) return { rows: this.catalog(this.phase === "committed" || this.phase === "before-commit").triggers };
    if (sql.includes("from pg_constraint where conrelid")) return { rows: this.catalog(this.phase === "committed" || this.phase === "before-commit").constraints };
    if (sql.includes("from public.comms_credit_policy")) return { rows: [this.catalog(this.phase === "committed" || this.phase === "before-commit").shape] };
    if (sql.includes("from pg_stat_activity")) return { rows: [state(false).activity] };
    return { rows: [] };
  }
}

function createScenario(options: ConstructorParameters<typeof FakeClient>[0] & { installedFirst?: boolean; disconnectFresh?: boolean } = {}) {
  const clients: FakeClient[] = [];
  return {
    clients,
    createClient: () => {
        const behavior = { failInterior: options.failInterior, failCommit: options.failCommit, asyncError: options.asyncError, columnLeak: options.columnLeak, wrongIndex: options.wrongIndex, wrongIndexKey: options.wrongIndexKey, weakConstraint: options.weakConstraint };
        const client = new FakeClient(behavior);
        if ((clients.length > 0 && !options.failInterior) || options.installedFirst) client.phase = "committed";
        if (clients.length > 0 && options.disconnectFresh) client.connect = async () => { throw new Error("socket disconnected"); };
        clients.push(client);
        return client;
      },
    connection: { host: `db.${STAGING}.supabase.co`, port: 5432, user: "cli_login_postgres", password: "private", database: "postgres", ssl: { rejectUnauthorized: true } },
  };
}

describe("communication billing apply CLI boundaries", () => {
  it("keeps the operation surface closed and requires exact apply acknowledgement", () => {
    expect(parseArgs([])).toEqual({ operation: "manifest" });
    expect(parseArgs(["--preflight-staging"])).toEqual({ operation: "preflight", target: "staging" });
    expect(parseArgs(["--verify-production"])).toEqual({ operation: "verify", target: "production" });
    expect(parseArgs(["--apply-staging", "--bundle-sha256", BUNDLE_SHA256])).toEqual({ operation: "apply", target: "staging" });
    expect(parseArgs(["--apply-production", "--bundle-sha256", BUNDLE_SHA256, "--waiver", WAIVER])).toEqual({ operation: "apply", target: "production", productionWaiver: true });
    for (const args of [
      ["--apply-staging"], ["--apply-staging", "--bundle-sha256", "wrong"],
      ["--apply-staging", "--waiver", WAIVER, "--bundle-sha256", BUNDLE_SHA256],
      ["--preflight-staging", "--bundle-sha256", BUNDLE_SHA256], ["--apply-staging", "--target", PRODUCTION],
      ["--apply-production", "--bundle-sha256", "wrong", "--waiver", WAIVER],
      ["--apply-staging", "--bundle-sha256", BUNDLE_SHA256, "--sql", "commit"],
      ["--apply-staging", "--bundle-sha256", BUNDLE_SHA256, "--bundle-sha256", BUNDLE_SHA256],
    ]) expect(() => parseArgs(args)).toThrow();
  });

  it("binds only the fixed target credentials and never exposes secrets in failures", () => {
    const output = `export PGHOST="db.${STAGING}.supabase.co"\nexport PGPORT="5432"\nexport PGUSER="cli_login_postgres"\nexport PGPASSWORD="top-secret"\nexport PGDATABASE="postgres"`;
    expect(connectionFromCli(output, "staging")).toMatchObject({ host: `db.${STAGING}.supabase.co`, port: 5432, user: "cli_login_postgres", database: "postgres", password: "top-secret" });
    const pooler = output.replace(`db.${STAGING}.supabase.co`, "aws-0-us-west-2.pooler.supabase.com").replace('cli_login_postgres"', `cli_login_postgres.${STAGING}"`);
    expect(connectionFromCli(pooler, "staging").ssl).toMatchObject({ rejectUnauthorized: true, servername: "aws-0-us-west-2.pooler.supabase.com" });
    for (const bad of [
      output.replace(`db.${STAGING}.supabase.co`, `db.${PRODUCTION}.supabase.co`),
      output.replace('PGPORT="5432"', 'PGPORT="6543"'),
      output.replace('PGDATABASE="postgres"', 'PGDATABASE="other"'),
      output.replace('PGUSER="cli_login_postgres"', 'PGUSER="attacker"'),
      `${output}\nexport PGHOST="db.${STAGING}.supabase.co"`,
    ]) {
      expect(() => connectionFromCli(bad, "staging")).toThrow(/No credentials, SQL, or database output/);
    }
  });

  it("executes the complete bundle interior in one transaction and inserts the auxiliary row before one COMMIT", async () => {
    const scenario = createScenario();
    const result = await runFixedOperation({ operation: "apply", target: "staging" }, scenario);
    expect(result).toEqual({ outcome: "success", target: "staging", migrationCount: 6 });
    const calls = scenario.clients[0].calls.map(({ sql }) => sql);
    const begin = calls.indexOf("BEGIN");
    const commit = calls.indexOf("COMMIT");
    const auxiliary = calls.findIndex((sql) => sql.includes("auxiliary ledger") || sql.startsWith("insert into supabase_migrations.schema_migrations"));
    const interior = calls.findIndex((sql) => sql.includes("-- exact source:"));
    expect(begin).toBeGreaterThan(-1);
    expect(interior).toBeGreaterThan(begin);
    expect(auxiliary).toBeGreaterThan(interior);
    expect(commit).toBeGreaterThan(auxiliary);
    expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(calls[interior]).not.toMatch(/^begin;\n/i);
    expect(calls[interior]).not.toMatch(/commit;\n?$/i);
    expect(calls[interior]).toBe(bundle.slice("begin;\n".length, -"commit;\n".length));
  });

  it("requires the full bundle digest and exact outer framing before any database operation", () => {
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(BUNDLE_SHA256);
    expect(bundle).toMatch(/^begin;\n/);
    expect(bundle).toMatch(/commit;\n$/);
    expect(bundle.slice("begin;\n".length, -"commit;\n".length)).not.toMatch(/^begin;|commit;\n?$/i);
  });

  it("keeps preflight read-only and verify read-only with no bundle or commit", async () => {
    const preflight = createScenario();
    await expect(runFixedOperation({ operation: "preflight", target: "staging" }, preflight)).resolves.toMatchObject({ outcome: "preflight_passed", target: "staging" });
    const preflightSql = preflight.clients[0].calls.map(({ sql }) => sql);
    expect(preflightSql).toContain("BEGIN READ ONLY");
    expect(preflightSql).toContain("ROLLBACK");
    expect(preflightSql).not.toContain("BEGIN");
    expect(preflightSql).not.toContain("COMMIT");
    expect(preflightSql.some((sql) => sql.includes("-- exact source:"))).toBe(false);
    expect(preflightSql.some((sql) => sql.startsWith("insert into supabase_migrations.schema_migrations"))).toBe(false);

    const verify = createScenario({ installedFirst: true });
    await expect(runFixedOperation({ operation: "verify", target: "staging" }, verify)).resolves.toEqual({ outcome: "verified", target: "staging", migrationCount: 6 });
    const verifySql = verify.clients[0].calls.map(({ sql }) => sql);
    expect(verifySql).toContain("BEGIN READ ONLY");
    expect(verifySql).not.toContain("COMMIT");
    expect(verifySql.some((sql) => sql.includes("-- exact source:"))).toBe(false);
  });

  it.each([
    ["a column-only anon grant", { columnLeak: true }],
    ["a same-name nonunique index", { wrongIndex: true }],
    ["a same-name wrong-key index", { wrongIndexKey: true }],
    ["a weakened usage constraint", { weakConstraint: true }],
  ])("rejects %s during installed verification", async (_label, behavior) => {
    const scenario = createScenario({ installedFirst: true, ...behavior });
    await expect(runFixedOperation({ operation: "verify", target: "staging" }, scenario)).rejects.toThrow(/catalog verification/);
  });

  it("rolls back before commit, performs fresh readback, and never retries a failed transaction", async () => {
    const scenario = createScenario({ failInterior: true });
    const result = await runFixedOperation({ operation: "apply", target: "staging" }, scenario);
    expect(result).toEqual({ outcome: "rolled_back_or_refused", target: "staging", migrationCount: 6 });
    const calls = scenario.clients[0].calls.map(({ sql }) => sql);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(scenario.clients).toHaveLength(2);
  });

  it("classifies a lost COMMIT response as uncertain and does not retry", async () => {
    const scenario = createScenario({ failCommit: true });
    const result = await runFixedOperation({ operation: "apply", target: "staging" }, scenario);
    expect(result).toEqual({ outcome: "uncertain_or_partial", target: "staging", migrationCount: 6 });
    expect(scenario.clients[0].calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(1);
    expect(scenario.clients).toHaveLength(2);
  });

  it("does not claim success when the fresh readback connection disconnects", async () => {
    const scenario = createScenario({ disconnectFresh: true });
    await expect(runFixedOperation({ operation: "apply", target: "staging" }, scenario)).resolves.toEqual({ outcome: "uncertain_or_partial", target: "staging", migrationCount: 6 });
    expect(scenario.clients[0].calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(1);
    expect(scenario.clients).toHaveLength(2);
  });

  it("bounds a connect that never resolves and sanitizes the timeout", async () => {
    vi.useFakeTimers();
    const scenario = createScenario();
    scenario.createClient = () => {
      const client = new FakeClient();
      client.connect = () => new Promise(() => {});
      scenario.clients.push(client);
      return client;
    };
    const pending = runFixedOperation({ operation: "preflight", target: "staging" }, scenario);
    const rejection = expect(pending).rejects.toThrow(/No credentials, SQL, or database output/);
    await vi.advanceTimersByTimeAsync(30_001);
    try {
      await rejection;
      expect(scenario.clients).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on asynchronous driver errors and reports no raw driver detail", async () => {
    const scenario = createScenario({ asyncError: true });
    await expect(runFixedOperation({ operation: "preflight", target: "staging" }, scenario)).rejects.toThrow(/No credentials, SQL, or database output/);
    await expect(runFixedOperation({ operation: "preflight", target: "staging" }, scenario)).rejects.not.toThrow("secret driver detail");
  });

  it("requires the named production waiver through the CLI boundary", async () => {
    const scenario = createScenario();
    await expect(runFixedOperation({ operation: "apply", target: "production" }, scenario)).rejects.toThrow();
    expect(scenario.clients).toHaveLength(0);
  });
});
