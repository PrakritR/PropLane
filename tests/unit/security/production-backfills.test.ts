import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
const connection = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../../scripts/security/production-database.mjs", async (original) => ({
  ...await original<object>(), productionDatabaseConfig: () => ({}), connectProductionDatabase: connection.connect,
}));
import { PRODUCTION_PROJECT, assertProductionUrl, productionConfigFromCliOutput } from "../../../scripts/security/production-database.mjs";
import { SECURITY_MIGRATIONS, parseProductionBackfillArgs, captureProductionRows, storageWithBackedUpOriginals,
  transformProductionRows, verifyProductionMigrationHistory, main } from "../../../scripts/security/production-backfills";
import { writeProductionSnapshot, decryptProductionSnapshot, SNAPSHOT_TABLES, type Snapshot } from "../../../scripts/security/production-backup";
import { decryptSensitiveValue } from "@/lib/security/data-encryption";

let directory: string;
let key: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "production-backup-test-"));
  key = randomBytes(32).toString("base64");
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "recovery_a");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ recovery_a: key }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${PRODUCTION_PROJECT}.supabase.co`);
  connection.connect.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function snapshot(kind: Snapshot["kind"] = "calendar"): Snapshot {
  return { project: PRODUCTION_PROJECT, kind, createdAt: "2026-09-05T00:00:00Z",
    rows: Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, []])), objects: [] };
}
function cli(host = "aws-0-us-west-2.pooler.supabase.com", user = `cli_login_postgres.${PRODUCTION_PROJECT}`) {
  return `export PGHOST="${host}"\nexport PGPORT="5432"\nexport PGUSER="${user}"\nexport PGPASSWORD="synthetic-test-secret"\nexport PGDATABASE="postgres"`;
}

describe("production-only operator guards", () => {
  it("requires exact target confirmation and private absolute backup path for apply", () => {
    expect(parseProductionBackfillArgs(["applicant"])).toMatchObject({ apply: false });
    const valid = ["applicant", "--apply", `--confirm-project=${PRODUCTION_PROJECT}`, `--backup-dir=${directory}`];
    expect(parseProductionBackfillArgs(valid)).toMatchObject({ apply: true });
    for (const args of [["applicant", "--apply"], [...valid, "--apply"], ["anything"], ["calendar", "--sql=delete"],
      ["document", "--apply", "--confirm-project=staging", `--backup-dir=${directory}`],
      ["document", "--apply", `--confirm-project=${PRODUCTION_PROJECT}`, "--backup-dir=relative"]]) {
      expect(() => parseProductionBackfillArgs(args)).toThrow();
    }
    expect(() => assertProductionUrl(`https://${PRODUCTION_PROJECT}.supabase.co`)).not.toThrow();
    expect(() => assertProductionUrl(`https://${PRODUCTION_PROJECT}.supabase.co.evil.test`)).toThrow();
    expect(() => assertProductionUrl("https://xwszcafaontidfgznlxd.supabase.co")).toThrow();
  });
  it("pins project-bound CLI identity, endpoint, database, port and verified TLS", () => {
    expect(productionConfigFromCliOutput(cli(), "public-ca")).toMatchObject({ ssl: { rejectUnauthorized: true, ca: "public-ca" }, port: 5432 });
    expect(() => productionConfigFromCliOutput(cli(`db.${PRODUCTION_PROJECT}.supabase.co`, "cli_login_postgres"))).not.toThrow();
    for (const output of [cli("evil.pooler.supabase.com.evil.test"), cli(undefined, "cli_login_postgres.staging"),
      cli().replace('PGPORT="5432"', 'PGPORT="6543"'), cli().replace('PGDATABASE="postgres"', 'PGDATABASE="other"'), `${cli()}\nexport PGHOST="evil"`]) {
      expect(() => productionConfigFromCliOutput(output)).toThrow();
    }
  });
  it("requires exact reviewed statements for all five migration histories", async () => {
    const records = SECURITY_MIGRATIONS.map((migration) => ({ name: migration.slice(15), statements: [readFileSync(new URL(`../../../supabase/migrations/${migration}.sql`, import.meta.url), "utf8")] }));
    let index = 0;
    const query = vi.fn(async () => ({ rows: [records[index++]] }));
    await expect(verifyProductionMigrationHistory({ query })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(5);
    for (const rows of [[], [{ ...records[0], name: "wrong" }], [{ ...records[0], statements: ["select 1"] }], [{ ...records[0], statements: [...records[0].statements, "extra"] }]]) {
      await expect(verifyProductionMigrationHistory({ query: async () => ({ rows }) })).rejects.toThrow();
    }
  });
});

describe("encrypted backup and independent key recovery", () => {
  it("writes no plaintext, reads back authenticated bytes, and recovers after replacing the runtime keyring", () => {
    const original = snapshot();
    original.rows.manager_automation_settings = [{ manager_user_id: "synthetic-owner", google_calendar: { accessToken: "synthetic-token-private" } }];
    const result = writeProductionSnapshot(directory, original);
    const archive = readFileSync(result.path, "utf8");
    expect(archive).not.toContain("synthetic-token-private");
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "{}");
    expect(() => decryptProductionSnapshot(archive)).toThrow();
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ recovery_a: randomBytes(32).toString("base64") }));
    expect(() => decryptProductionSnapshot(archive)).toThrow();
    // Simulates retrieving an independent saved key, without keeping it in the runtime environment.
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ recovery_a: key, recovery_b: randomBytes(32).toString("base64") }));
    vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "recovery_b");
    expect(decryptProductionSnapshot(archive)).toEqual(original);
    const tampered = JSON.parse(archive);
    tampered.id = "00000000-0000-0000-0000-000000000000";
    expect(() => decryptProductionSnapshot(JSON.stringify(tampered))).toThrow();
  });
  it("refuses a readable-by-others backup directory before writing sensitive content", () => {
    chmodSync(directory, 0o755);
    expect(() => writeProductionSnapshot(directory, snapshot())).toThrow();
  });
  it("checks row and byte ceilings before retrieving full rows and locks only the affected table", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("select count") ? [{ rows: "0", bytes: "0" }] : [] }));
    await captureProductionRows({ query }, "applicant", true);
    const sql = query.mock.calls.map(([statement]) => statement);
    expect(sql.filter((statement) => statement.endsWith("for update"))).toEqual(["select * from public.manager_application_records limit 10001 for update"]);
    const large = vi.fn(async () => ({ rows: [{ rows: "10001", bytes: "0" }] }));
    await expect(captureProductionRows({ query: large }, "applicant", true)).rejects.toThrow();
    expect(large).toHaveBeenCalledTimes(1);
  });
});

describe("existing backfill semantics in production", () => {
  it("rolls back before any update when backup verification cannot complete", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("select name, statements")) {
        const migration = SECURITY_MIGRATIONS.find((name) => name.startsWith(String(values?.[0])))!;
        return { rows: [{ name: migration.slice(15), statements: [readFileSync(new URL(`../../../supabase/migrations/${migration}.sql`, import.meta.url), "utf8")] }] };
      }
      if (sql.startsWith("select count")) return { rows: [{ rows: "0", bytes: "0" }] };
      return { rows: [] };
    });
    const end = vi.fn(async () => undefined);
    connection.connect.mockResolvedValue({ query, end });
    chmodSync(directory, 0o755);
    await expect(main(["calendar", "--apply", `--confirm-project=${PRODUCTION_PROJECT}`, `--backup-dir=${directory}`])).rejects.toThrow();
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain("rollback");
    expect(statements).not.toContain("commit");
    expect(statements.some((sql) => sql.startsWith("update"))).toBe(false);
    expect(end).toHaveBeenCalledOnce();
  });
  it("protects both dedicated and fallback OAuth fields while preserving metadata and parameterizing writes", async () => {
    const source = snapshot();
    source.rows.manager_automation_settings = [{ manager_user_id: "synthetic-owner", google_calendar: { accessToken: "one", connected: true },
      row_data: { keep: 1, google_calendar: { refreshToken: "two" } }, updated_at: "previous" }];
    const query = vi.fn(async () => ({ rows: [{ column_name: "google_calendar" }, { column_name: "row_data" }] }));
    expect(await transformProductionRows({ query }, source, true)).toMatchObject({ changedRows: 1, plaintextFields: 2 });
    const [sql, parameters] = query.mock.calls[1] as unknown as [string, string[]];
    expect(sql).toContain("where manager_user_id = $3");
    expect(sql).not.toContain("synthetic-owner");
    const calendar = JSON.parse(parameters[0]);
    expect(calendar.connected).toBe(true);
    expect(decryptSensitiveValue(calendar.accessToken, { purpose: "google-calendar-oauth", ownerId: "synthetic-owner", recordId: "synthetic-owner", field: "accessToken" })).toBe("one");
    expect(JSON.parse(parameters[1]).keep).toBe(1);
    query.mockClear();
    await transformProductionRows({ query }, source, false);
    expect(query).toHaveBeenCalledTimes(1); // Schema check only; dry run has no UPDATE.
  });
  it("rejects changed or unbacked document sources while allowing replacement ciphertext verification", async () => {
    const source = snapshot("document");
    source.objects = [{ applicationId: "synthetic", path: "application/synthetic/original.pdf", bytes: "", sha256: "not-the-current-hash", contentType: "application/pdf" }];
    const download = vi.fn(async () => ({ error: null, data: new Blob(["changed"]) }));
    const storage = { storage: { from: () => ({ download }) } } as unknown as SupabaseClient;
    const guarded = storageWithBackedUpOriginals(storage, source).storage.from("application-documents");
    await expect(guarded.download(source.objects[0].path)).rejects.toThrow();
    await expect(guarded.download("application/synthetic/new.pdf")).rejects.toThrow();
    await expect(guarded.download("application/synthetic/new.pdf.penc")).resolves.toMatchObject({ error: null });
  });
});
