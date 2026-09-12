import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  correctionFunctionBody,
  executeGuardedLedgerRenames,
  guardedRenameSql,
  inspectCapturedLedger,
  normalizeSql,
  occupancyContractIsPresent,
  parseArgs,
  PRODUCTION_BUNDLE_LINEAGE,
  productionMirrorAttestationTemplate,
} from "../../scripts/prepare-prospect-sms-migration-reconciliation.mjs";

const portalColumnsSql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260716090000_agent_pending_actions_portal_columns.sql"), "utf8");
const fixtureLedger = (target: "staging" | "production") => [
  { version: "20260713000000", name: "agent_pending_actions", statements: ["create table public.agent_pending_actions(id uuid)"] },
  { version: "20260716090000", name: "agent_pending_actions", statements: portalColumnsSql.split(";").filter(Boolean) },
  ...(target === "staging" ? [{ version: "20260907073044", name: "resident_invite_links", statements: ["select 'legacy'"] }, { version: "20260907090000", name: "resident_invite_links", statements: ["select 'canonical'"] }] : []),
];

describe("prospect SMS migration reconciliation", () => {
  it("maps only the reviewed DDL batches and preserves production bundle lineage", () => {
    const staging = inspectCapturedLedger("staging", fixtureLedger("staging"));
    expect(staging.pendingDdl).toEqual(expect.arrayContaining(["20260912143000_prospect_sms_bursts", "20260912150000_shared_room_capacity_normalization_occupancy_start"]));
    const production = inspectCapturedLedger("production", fixtureLedger("production"));
    expect(production.pendingDdl).toEqual(["20260912143000_prospect_sms_bursts", "20260912150000_shared_room_capacity_normalization_occupancy_start"]);
    expect(production.bundledProductionLineage).toContainEqual(["20260906070000_shared_room_capacity", "20260906214429_shared_room_capacity_helpers + 20260906214510_shared_room_capacity_triggers"]);
  });

  it("rejects an unexpected old identity, source SQL, or an occupied replacement name", () => {
    const ledger = fixtureLedger("staging");
    expect(() => inspectCapturedLedger("staging", ledger.map((row: { version: string; name: string }) => row.version === "20260716090000" ? { ...row, name: "wrong" } : row))).toThrow("expected old identity");
    expect(() => inspectCapturedLedger("staging", ledger.map((row: { version: string; statements: string[] }) => row.version === "20260716090000" ? { ...row, statements: ["unexpected SQL"] } : row))).toThrow("expected SQL differs");
    expect(() => inspectCapturedLedger("staging", [...ledger, { version: "20990101000000", name: "agent_pending_actions_portal_columns", statements: ["inert"] }])).toThrow("new identity is already occupied");
  });

  it("normalizes comments and whitespace without treating changed executable SQL as equal", () => {
    expect(normalizeSql("select 1 -- harmless\n")).toBe(normalizeSql(" select   1 "));
    expect(normalizeSql("select 1")).not.toBe(normalizeSql("select 2"));
  });

  it("requires the occupancy floor in the shared-room final catalog contract", () => {
    const correction = readFileSync(resolve(process.cwd(), "supabase/migrations/20260912150000_shared_room_capacity_normalization_occupancy_start.sql"), "utf8");
    const body = correction.match(/\bas \$\$\n?([\s\S]*?)\n?\$\$;/i)?.[1] ?? "";
    expect(occupancyContractIsPresent(body)).toBe(true);
    expect(occupancyContractIsPresent("create function x() returns void language sql as $$ select 1 $$")).toBe(false);
    expect(occupancyContractIsPresent("insert into public.manager_application_records (occupancy_start) values (old_row.occupancy_start); select occupancy_start;")).toBe(false);
    expect(() => correctionFunctionBody({ readSource: () => "changed" })).toThrow("shared-room correction source changed");
  });

  it("pins every production mirror to a recorded bundle row and source digest", () => {
    const source = (identity: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", `${identity}.sql`), "utf8");
    const bundles = new Map<string, string[]>();
    for (const [identity, bundle] of PRODUCTION_BUNDLE_LINEAGE) {
      if (bundle) bundles.set(bundle.split(" + ")[0]!, [...(bundles.get(bundle.split(" + ")[0]!) ?? []), source(identity)]);
    }
    const ledger = [
      ...fixtureLedger("production"),
      ...[...bundles].map(([identity, statements]) => {
        const [, version, name] = identity.match(/^(\d{14})_(.+)$/)!;
        return { version, name, statements };
      }),
    ];
    const template = productionMirrorAttestationTemplate(ledger, { catalogSha256: "a".repeat(64), sharedRoomOccupancyCatalogSha256: "b".repeat(64) });
    expect(template.mirrors).toHaveLength(PRODUCTION_BUNDLE_LINEAGE.length);
    expect(template.mirrors.every((row) => /^[a-f0-9]{64}$/.test(row.sourceSha256))).toBe(true);
  });

  it("binds the target, locks the ledger, verifies each expected old SQL array, and rolls back a refused repair", async () => {
    const expectedLedger = fixtureLedger("staging");
    const calls: string[] = [];
    let renameCount = 0;
    const client = {
      connect: async () => undefined,
      end: async () => undefined,
      query: async (sql: string, values?: unknown[]) => {
        calls.push(sql);
        if (sql.startsWith("select version,name")) return { rows: expectedLedger };
        if (sql === guardedRenameSql()) {
          renameCount += 1;
          expect(values?.[1]).toMatch(/^2026/);
          return { rowCount: renameCount === 1 ? 1 : 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    await expect(executeGuardedLedgerRenames({
      target: "staging",
      dbUrl: "postgresql://cli_login_postgres.xwszcafaontidfgznlxd:secret@aws-1-us-west-2.pooler.supabase.com/postgres",
      expectedLedger,
      createClient: () => client,
    })).rejects.toThrow("identity repair refused");
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("lock table supabase_migrations.schema_migrations in share row exclusive mode");
    expect(calls).toContain("ROLLBACK");
  });

  it("refuses a production connection for a staging operation before constructing a client", async () => {
    await expect(executeGuardedLedgerRenames({
      target: "staging",
      dbUrl: "postgresql://cli_login_postgres.qahnczmilgptcedaqype:secret@aws-1-us-west-2.pooler.supabase.com/postgres",
      expectedLedger: fixtureLedger("staging"),
      createClient: () => { throw new Error("must not connect"); },
    })).rejects.toThrow("target binding refused");
  });

  it("accepts only explicit, single-valued CLI arguments", () => {
    expect(parseArgs(["--target", "staging", "--ledger", "/private/ledger.json"])).toMatchObject({ target: "staging", ledger: "/private/ledger.json", apply: false });
    expect(() => parseArgs(["--target", "staging", "--ledger", "/private/a", "--ledger", "/private/b"])).toThrow("invalid arguments");
    expect(() => parseArgs(["--target", "production", "--ledger", "/private/a", "--apply", "--db-url", "postgresql://example"])).toThrow("invalid arguments");
  });
});
