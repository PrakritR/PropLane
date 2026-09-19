import { describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cliTransactionGuardSql, doBlock, expectedFunctionAfter, pgFunctionDefinitionDelimiter, functionGuardSql, historyNameRecoverySql, assertCapturedProgress, assertExactDryRun, assertFreshEvidenceMatches, assertReleaseReadiness, catalogGuardSql, evidenceFingerprint, expectedMigrationIdentities, expectedPostCatalog, extractPlannedMigrationIdentities, ledgerGuardSql, parseArgs, readPinned, releaseSequence, renameHistorySql, reconciliationSql, serializeHistoricalStatements, sha256, TARGETS } from "../../scripts/release-conversation-schema-reconciliation.mjs";

const catalog = { columns: [{ table: "portal_workspaces", name: "id", type: "uuid", not_null: true, default: null, comment: null }], constraints: [{ table: "portal_workspaces", name: "portal_workspaces_pkey", type: "p", definition: "PRIMARY KEY (id)", validated: true, deferrable: false, deferred: false }], indexes: [{ table: "portal_workspaces", name: "portal_workspaces_pkey", definition: "CREATE UNIQUE INDEX portal_workspaces_pkey ON public.portal_workspaces USING btree (id)", valid: true, ready: true, live: true }] };
const ledger = [{ version: "20260916000000", name: "automated_communication_reminder_kinds", statements: ["select old;"], extra: "preserve me" }, { version: "20260916063005", name: "automated_communication_reminder_kinds", statements: ["create table x;", "comment on table x is 'x';"], extra: "preserve me" }, { version: "20260917010000", name: "invite_workspace", statements: null, checksum: "abc" }, { version: "20260918000000", name: "other", statements: ["select 1"] }];

describe("conversation release schema reconciliation", () => {
  it("pins exactly four staging and five production migrations", () => {
    expect(TARGETS.staging.migrations).toEqual([
      "invite_workspace",
      "workspace_permissions",
      "account_link_team_role",
      "booking_com_calendar_provider",
    ]);
    expect(TARGETS.production.migrations).toEqual([
      "team_delivery_recipient_key",
      "invite_workspace",
      "workspace_permissions",
      "account_link_team_role",
      "booking_com_calendar_provider",
    ]);
  });

  it("rejects target overrides and every apply invocation", () => {
    expect(parseArgs(["--target", "staging"])).toEqual({ target: "staging" });
    expect(() => parseArgs(["--target", "dev"])).toThrow(/exact target|Usage/);
    expect(() => parseArgs(["--target", "production", "--apply"])).toThrow(/preparation-only/);
  });

  it("generates a full ledger guard with metadata and array dimensions", () => {
    const sql = ledgerGuardSql(ledger);
    expect(sql).toContain("full ledger differs"); expect(sql).toContain("ledger array dimensions differ"); expect(sql).toContain("preserve me"); expect(sql).toContain("checksum"); expect(sql).toContain("[1:2]");
    expect(() => ledgerGuardSql([])).toThrow(/empty ledger/);
    expect(() => ledgerGuardSql([{ version: "bad", name: "x", statements: [] }])).toThrow(/invalid ledger identity/);
    expect(() => ledgerGuardSql([{ version: "20260101000000", name: "x", statements: [1] }])).toThrow(/statement shape/);
  });

  it("hashes exact ordered UTF-8 bytes without embedding historical SQL", () => {
    const statements = ["select '雪😀';\n", "select 'a\\b';  ", "select 'é';", "select 'é';"];
    const row = { version: "20260101000000", name: "old", statements };
    const sql = ledgerGuardSql([row]);
    for (const statement of statements) {
      expect(sql).toContain(sha256(Buffer.from(statement, "utf8")));
      expect(sql).not.toContain(statement);
    }
    expect(sql).not.toBe(ledgerGuardSql([{ ...row, statements: [...statements].reverse() }]));
    expect(ledgerGuardSql([{ ...row, statements: null }])).not.toBe(ledgerGuardSql([{ ...row, statements: [] }]));
  });

  it("chooses a delimiter absent from the complete captured body", () => {
    const body = "begin perform '$ledger_guard$ $ledger_guard_1$'; end";
    expect(doBlock(body)).toBe(`do $ledger_guard_2$ ${body} $ledger_guard_2$;`);
    const fn = { definition: "select '$function_guard$'", owner: "postgres", config: null, acl: null };
    expect(functionGuardSql(fn)).toMatch(/^do \$function_guard_1\$/);
    const collision = { ...catalog, columns: catalog.columns.map(column => ({ ...column, comment: "$catalog_guard$" })) };
    expect(catalogGuardSql(collision)).toMatch(/^do \$catalog_guard_1\$/);
    const changed = ledger.map(row => row.version === "20260916063005" ? { ...row, statements: ["select '$rename_history$'"] } : row);
    expect(renameHistorySql(changed)).toMatch(/^do \$rename_history_1\$/);
  });

  it("nests transaction-local settings and locks for the CLI extended batch", () => {
    const sql = cliTransactionGuardSql({
      lockTimeout: "5s", statementTimeout: "30s",
      locks: [
        { relations: ["supabase_migrations.schema_migrations"], mode: "exclusive" },
        { relations: ["public.portal_inbox_thread_records"], mode: "share row exclusive" },
      ],
      tag: "resident_read_transaction",
    });
    expect(sql).toMatch(/^do \$resident_read_transaction\$ begin\n set local standard_conforming_strings = on;/);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("lock table supabase_migrations.schema_migrations in exclusive mode;");
    expect(sql).toContain("lock table public.portal_inbox_thread_records in share row exclusive mode;");
    expect(sql).not.toMatch(/^set local/m);
    expect(sql).not.toMatch(/^lock table/m);
    expect(sql).not.toMatch(/^\s*(?:begin|commit);/mi);
    expect(() => cliTransactionGuardSql({ locks: [{ relations: ["public.safe; drop table x"], mode: "exclusive" }] })).toThrow(/transaction lock/);
  });

  it("recanonicalizes the corrected function body with a collision-free pg delimiter", () => {
    const captured = {
      definition: "CREATE OR REPLACE FUNCTION public.x()\n RETURNS void\n LANGUAGE plpgsql\nAS $functionx$ begin return '$function_guard$ original'; end $functionx$\n",
      owner: "postgres", config: null, acl: null,
    };
    expect(expectedFunctionAfter(captured).definition).toMatch(/AS \$function\$[\s\S]*\$function\$/);
    expect(expectedFunctionAfter(captured)).toMatchObject({ owner: captured.owner, config: captured.config, acl: captured.acl });
    expect(expectedFunctionAfter(captured).definition.split("AS ")[0]).toBe(captured.definition.split("AS ")[0]);
  });

  it("matches PostgreSQL's function delimiter prefix collision rule", () => {
    expect(pgFunctionDefinitionDelimiter("begin return 'plain'; end")).toBe("$function$");
    expect(pgFunctionDefinitionDelimiter("begin return '$function_guard$ original'; end")).toBe("$functionx$");
    expect(pgFunctionDefinitionDelimiter("begin return '$function$ $functionx_suffix'; end")).toBe("$functionxx$");
  });

  it("bounds sequential recorded-guard growth", () => {
    const history = [{ version: "20260101000000", name: "old", statements: ["x".repeat(100_000)] }];
    const sizes: number[] = [];
    for (let step = 0; step < 6; step++) {
      const sql = ledgerGuardSql(history);
      sizes.push(Buffer.byteLength(sql));
      history.push({ version: `2026091902000${step}`, name: `step_${step}`, statements: [sql] });
    }
    expect(sizes[0]).toBeLessThan(3000);
    expect(sizes[5] - sizes[0]).toBeLessThan(3000);
  });

  it("refuses recovery without an actual correction history row", () => {
    expect(() => historyNameRecoverySql(ledger)).toThrow(/reconciled history/);
  });

  it("ignores capture time but rejects semantic fresh-evidence drift", () => {
    const pinned = { target: "project", capturedAt: "old", ledger: [], active_invites: [], lease_function: { acl: [] } };
    const fresh = { ...pinned, capturedAt: "new" };
    expect(evidenceFingerprint(pinned)).toBe(evidenceFingerprint(fresh));
    expect(assertFreshEvidenceMatches(pinned, fresh)).toBe(true);
    expect(() => assertFreshEvidenceMatches(pinned, { ...fresh, ledger: [{ version: "changed" }] })).toThrow(/differs/);
  });

  it("serializes historical statements without inventing payloads", () => {
    expect(serializeHistoricalStatements(["select 1", "select 2;"])).toBe("select 1;\nselect 2;");
    expect(serializeHistoricalStatements(null)).toContain("Historical null payload");
    expect(() => serializeHistoricalStatements(["select 1", 2 as unknown as string])).toThrow(/statement shape/);
  });

  it("requires non-empty catalog evidence and guards all categories", () => {
    const sql = catalogGuardSql(catalog); expect(sql).toContain("catalog differs: %"); expect(sql).toContain("columns"); expect(sql).toContain("constraints"); expect(sql).toContain("indexes");
    expect(() => catalogGuardSql({ ...catalog, indexes: [] })).toThrow(/catalog evidence missing/); expect(() => catalogGuardSql(undefined)).toThrow(/catalog evidence missing/);
  });

  it("accepts only private regular files matching their byte digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-reconciliation-"));
    try {
      const file = join(dir, "capture"); const bytes = Buffer.from("capture"); writeFileSync(file, bytes, { mode: 0o600 });
      expect(readPinned(file, sha256(bytes))).toEqual(bytes);
      expect(() => readPinned(file, sha256("changed"))).toThrow(/file digest/);
      writeFileSync(file, "mutated");
      expect(() => readPinned(file, sha256(bytes))).toThrow(/file digest/);
      chmodSync(file, 0o644); expect(() => readPinned(file, sha256(bytes))).toThrow(/permissions/);
      const link = join(dir, "link"); symlinkSync(file, link); expect(() => readPinned(link, sha256(bytes))).toThrow(/file type/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("renames by name only and preserves the selected payload", () => {
    const sql = renameHistorySql(ledger); expect(sql).toContain("set name='automated_communication_reminder_kinds_reapplied_20260916063005'"); expect(sql).toContain("to_jsonb(statements) is not distinct from"); expect(sql).toContain("full ledger differs");
    expect(() => renameHistorySql(ledger.map(row => row.version === "20260918000000" ? { ...row, name: "automated_communication_reminder_kinds" } : row))).toThrow(/duplicate pair/);
    expect(() => renameHistorySql(ledger.map(row => row.version === "20260916063005" ? { ...row, name: "wrong" } : row))).toThrow(/duplicate pair/);
    expect(() => renameHistorySql([...ledger, { version: "20260919020000", name: "automated_communication_reminder_kinds_reapplied_20260916063005", statements: [] }])).toThrow(/duplicate pair/);
  });

  it("keeps short transaction-local timeouts and exact source DDL", () => {
    const evidence = { ledger, catalog, active_invites: [], lease_function: { definition: "create function x() returns void language sql as $$select 1$$;", owner: "postgres", config: null, acl: null } };
    const sql = reconciliationSql("invite_workspace", evidence);
    expect(sql).toMatch(/^do \$reconciliation_transaction\$ begin/);
    expect(sql).toContain("set local lock_timeout = '3s'");
    expect(sql).not.toMatch(/^set local/m);
    expect(sql).not.toMatch(/^lock table/m);
    expect(() => reconciliationSql("invite_workspace", undefined)).toThrow(/authenticated transaction evidence/);
  });

  it("accepts only the exact ordered dry-run selection", () => {
    const versions = ["20260917010000", "20260918153000", "20260918180000", "20260919010000"];
    const expected = TARGETS.staging.migrations.map((name, index) => `${versions[index]}_${name}`);
    const output = expected.map((identity) => `${identity}.sql`).join("\n");
    expect(extractPlannedMigrationIdentities(output)).toEqual(expected);
    expect(assertExactDryRun(output, expected)).toBe(true);
    expect(() => assertExactDryRun(`${output}\n20260919999999_unreviewed.sql`, expected)).toThrow(/exact/);
    expect(() => assertExactDryRun(output, expected, 1)).toThrow(/exact/); expect(() => assertExactDryRun(`${output}\n20260919999999_unreviewed.sql`, expected)).toThrow(/exact/); expect(() => assertExactDryRun(`${output}\n${expected[0]}.sql`, expected)).toThrow(/exact/);
  });

  it("requires fresh semantic evidence in the explicit staging readiness gate", () => {
    const fabricated = { target: TARGETS.staging.projectRef, ledger: [], catalog }; expect(() => assertReleaseReadiness()).toThrow(/owner transport requires authenticated review/); expect(() => assertReleaseReadiness("staging", fabricated, fabricated)).toThrow(/owner transport requires authenticated review/); expect(() => assertReleaseReadiness("production", { ...fabricated, target: TARGETS.production.projectRef }, fabricated)).toThrow(/owner transport requires authenticated review/);
  });

  it("rejects fabricated progress, wrong target, ledger drift, and function ACL drift", () => {
    const initial = { target: TARGETS.staging.projectRef, active_invites: [{ id: "invite-1" }], catalog, ledger: [{ version: "20260916000000", name: "old", statements: ["select 1"] }], lease_function: { owner: "postgres", config: null, acl: null } };
    const identity = releaseSequence("staging")[0];
    const added = { version: identity.slice(0, 14), name: identity.slice(15), statements: ["select 2"] };
    const fresh = { ...initial, catalog: expectedPostCatalog(catalog, "invite_workspace"), ledger: [...initial.ledger, added] };
    const receipt = { identity, ledgerRowSha256: "deadbeef" };
    expect(() => assertCapturedProgress("staging", initial, fresh, [receipt])).toThrow(/exact reviewed actual ledger row/);
    const validReceipt = { identity, ledgerRowSha256: sha256(JSON.stringify({ name: added.name, statements: added.statements, version: added.version })) };
    expect(assertCapturedProgress("staging", initial, fresh, [validReceipt])).toBe(releaseSequence("staging")[1]);
    expect(() => assertCapturedProgress("production", initial, fresh, [])).toThrow(/capture target/);
    expect(() => assertCapturedProgress("staging", initial, { ...fresh, ledger: [{ ...added, statements: ["changed"] }, initial.ledger[0]] }, [validReceipt])).toThrow(/historical ledger differs|completed step/);
    expect(() => assertCapturedProgress("staging", initial, { ...fresh, lease_function: { ...initial.lease_function, acl: ["changed"] } }, [validReceipt])).toThrow(/function privileges differ/);
    for (const category of ["columns", "constraints", "indexes"] as const) {
      const changed = structuredClone(fresh);
      changed.catalog[category].pop();
      expect(() => assertCapturedProgress("staging", initial, changed, [validReceipt])).toThrow(/post-step catalog differs/);
    }
  });
});
