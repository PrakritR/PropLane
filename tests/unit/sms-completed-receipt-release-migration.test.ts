import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION, TARGETS, assertFunction, assertIndex, assertLedger, functionBody, parseOptions, reviewedIndexes, reviewedSource, runMigration,
} from "../../scripts/sms-completed-receipt-release-migration.mjs";
import { reviewedSmsMigrations, sha256 } from "../../scripts/sms-durability-release-manifest.mjs";

const sql = readFileSync(new URL("../../supabase/migrations/20260926150000_sms_completed_receipt_originals.sql", import.meta.url), "utf8");
const six = reviewedSmsMigrations();
const source = {
  six, sql,
  resolverBody: functionBody(sql, "resolve_sms_completed_receipt_original"),
  importerBody: functionBody(sql, "import_sms_projection_historical_event"),
  oldImporterBody: functionBody(six.at(-1)!.sql, "import_sms_projection_historical_event"),
  indexes: reviewedIndexes(sql),
};
const sixRows = source.six.map((migration) => ({
  version: migration.version, name: migration.name, statements: [migration.sql],
}));
const seventh = { version: MIGRATION.version, name: MIGRATION.name, statements: [source.sql] };

function db(rows: typeof sixRows) {
  return { query: vi.fn(async () => ({ rows })) };
}

describe("completed-receipt migration operation", () => {
  it("pins one new source and both function bodies after the six immutable SMS migrations", () => {
    if (sha256(sql) === MIGRATION.hash) expect(reviewedSource()).toMatchObject({ sql });
    else expect(() => reviewedSource()).toThrow("source hash changed");
    expect(source.six).toHaveLength(6);
    expect(source.resolverBody).toContain("p_expected_owner");
    expect(source.importerBody.match(/public\.resolve_sms_completed_receipt_original\(/g)).toHaveLength(2);
    expect(source.importerBody).not.toBe(source.oldImporterBody);
    expect(functionBody(source.sql, "resolve_sms_completed_receipt_original")).toBe(source.resolverBody);
    expect(source.indexes.map((index) => index.name)).toContain("manager_sms_numbers_historic_phone_epoch_idx");
    expect(source.indexes.map((index) => index.name)).toContain("sms_inbound_receipts_payload_cursor_idx");
    expect(() => reviewedIndexes(sql.replace("(coalesce(provisioned_at,requested_at)),released_at)",
      "(coalesce(provisioned_at,requested_at)),requested_at)"))).toThrow("index source changed");
  });

  it("requires a fixed target and explicit apply authorization with a new backup", () => {
    expect(TARGETS).toEqual({
      dev: "emstjswhotsnyksqhqyf", staging: "xwszcafaontidfgznlxd", production: "qahnczmilgptcedaqype",
    });
    expect(parseOptions(["--target", "dev"])).toMatchObject({ target: "dev", phase: "preflight" });
    expect(() => parseOptions(["--target", "other"])).toThrow();
    expect(() => parseOptions(["--target", "production", "--phase", "apply"])).toThrow();
    expect(() => parseOptions(["--target", "production", "--phase", "apply", "--apply-authorized"])).toThrow();
    expect(() => parseOptions(["--target", "staging", "--backup-file", "/private/tmp/foo.dump"])).toThrow();
    expect(() => parseOptions(["--target", "dev", "--phase", "apply", "--apply-authorized", "--backup-file", "/private/tmp/foo.dump"])).toThrow();
  });

  it("requires all six exact prior ledger rows and an absent seventh before apply", async () => {
    await expect(assertLedger(db(sixRows), source.six, false)).resolves.toBeUndefined();
    await expect(assertLedger(db(sixRows.slice(1)), source.six, false)).rejects.toThrow();
    await expect(assertLedger(db([{ ...sixRows[0]!, statements: ["changed"] }, ...sixRows.slice(1)]), source.six, false)).rejects.toThrow();
    await expect(assertLedger(db([...sixRows, seventh]), source.six, false)).rejects.toThrow();
  });

  it("requires one exact new ledger row after apply", async () => {
    if (sha256(sql) === MIGRATION.hash) {
      await expect(assertLedger(db([...sixRows, seventh]), source.six, true)).resolves.toBeUndefined();
    } else {
      await expect(assertLedger(db([...sixRows, seventh]), source.six, true)).rejects.toThrow("ledger differs");
    }
    await expect(assertLedger(db(sixRows), source.six, true)).rejects.toThrow();
    await expect(assertLedger(db([...sixRows, { ...seventh, statements: ["changed"] }]), source.six, true)).rejects.toThrow();
    await expect(assertLedger(db([...sixRows, seventh, seventh]), source.six, true)).rejects.toThrow();
  });

  it("rejects a changed resolver body or callable public ACL", async () => {
    const matching = {
      prosrc: source.resolverBody, prosecdef: true, provolatile: "v",
      proconfig: ["search_path=public, pg_temp"], owner: "postgres",
      anon_access: false, auth_access: false, service_access: true,
    };
    const client = (detail: typeof matching) => ({ query: vi.fn(async (statement: string) => ({
      rows: statement.includes("select p.oid::text") ? [{ oid: "1" }] : [detail],
    })) });
    await expect(assertFunction(client(matching), "resolve_sms_completed_receipt_original(text,uuid)",
      "resolve_sms_completed_receipt_original", source.resolverBody, 1)).resolves.toBeUndefined();
    for (const detail of [{ ...matching, prosrc: "changed" }, { ...matching, anon_access: true },
      { ...matching, auth_access: true }, { ...matching, service_access: false }]) {
      await expect(assertFunction(client(detail), "resolve_sms_completed_receipt_original(text,uuid)",
        "resolve_sms_completed_receipt_original", source.resolverBody, 1)).rejects.toThrow("definition/ACL mismatch");
    }
  });

  it("rejects missing, incompatible, and invalid reviewed indexes", async () => {
    const spec = { name: "reviewed_index", table: "manager_sms_numbers", method: "btree", unique: false,
      keys: ["phone_number"], predicates: ["provision_state = 'active'::text"] };
    const matching = { schema_name: "public", index_kind: "i", table_schema: "public",
      table_name: "manager_sms_numbers", method: "btree", is_unique: false,
      is_valid: true, is_ready: true, key_count: 1, key_definitions: ["phone_number"],
      predicate: "provision_state = 'active'::text" };
    const client = (rows: typeof matching[]) => ({ query: vi.fn(async () => ({ rows })) });
    await expect(assertIndex(client([]), spec, false)).resolves.toBeUndefined();
    await expect(assertIndex(client([]), spec, true)).rejects.toThrow("index definition mismatch");
    await expect(assertIndex(client([matching]), spec, true)).resolves.toBeUndefined();
    for (const row of [{ ...matching, table_name: "other" }, { ...matching, method: "hash" },
      { ...matching, key_definitions: ["requested_at"] }, { ...matching, is_valid: false },
      { ...matching, is_ready: false }, { ...matching, is_unique: true },
      { ...matching, predicate: null }]) {
      await expect(assertIndex(client([row]), spec, false)).rejects.toThrow("index definition mismatch");
    }
  });

  it("does not enter DDL if backup fails", async () => {
    const query = vi.fn(async () => ({ rows: [{ acquired: true }] }));
    const client = { query, end: vi.fn(async () => undefined) };
    const backup = vi.fn(() => { throw new Error("backup invalid"); });
    await expect(runMigration({ target: "dev", phase: "apply", backupFile: "offline.dump" }, {
      reviewedSource: () => source, credential: () => ({}), connect: async () => client,
      backup, catalog: async () => undefined,
    })).rejects.toThrow("backup invalid");
    expect(backup).toHaveBeenCalledOnce();
    expect(query.mock.calls.map(([statement]) => statement)).toEqual(["begin read only", "set local role postgres", "rollback"]);
  });

  it("does not reconnect or apply again after an ambiguous commit", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement === "commit") throw new Error("connection lost");
      return { rows: [{ acquired: true }] };
    });
    const client = { query, end: vi.fn(async () => undefined) };
    const connect = vi.fn(async () => client);
    await expect(runMigration({ target: "dev", phase: "apply", backupFile: "offline.dump" }, {
      reviewedSource: () => source, credential: () => ({}), connect,
      backup: () => undefined, catalog: async () => undefined,
    })).rejects.toThrow("connection lost");
    expect(connect).toHaveBeenCalledOnce();
    expect(query.mock.calls.filter(([statement]) => statement === source.sql)).toHaveLength(1);
    expect(query.mock.calls.filter(([statement]) => statement === "commit")).toHaveLength(1);
  });
});
