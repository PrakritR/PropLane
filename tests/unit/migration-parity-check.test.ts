import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffMigrations,
  hasFatalMigrationDrift,
  migrationIdentityProblems,
  parseArguments,
  parseMigrationFileNames,
  TARGET_PROJECT_REFS,
  validateTargetConnection,
} from "../../scripts/check-migration-parity.mjs";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("reading the repo's own migrations", () => {
  it("parses every .sql file in supabase/migrations", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql"));
    const parsed = parseMigrationFileNames(files);
    const parsedFiles = new Set(parsed.map((row) => `${row.version}_${row.name}.sql`));
    expect(files.filter((file) => !parsedFiles.has(file)), "migration filenames must carry a name").toEqual([]);
    expect(parsed).toHaveLength(files.length);
  });

  it("keeps versions ordered and surfaces the existing duplicate name", () => {
    const parsed = parseMigrationFileNames(readdirSync(MIGRATIONS_DIR));
    expect(migrationIdentityProblems(parsed, "repo")).toEqual([
      expect.objectContaining({
        source: "repo",
        kind: "duplicate-name",
        version: "20260716090000",
        name: "agent_pending_actions",
      }),
    ]);
    expect(parsed.map((row) => row.version)).toEqual(parsed.map((row) => row.version).sort());
  });

  it("includes the migration whose absence broke the waiver code", () => {
    const parsed = parseMigrationFileNames(readdirSync(MIGRATIONS_DIR));
    expect(parsed.some((row) => row.name === "scope_application_fee_waiver_codes_to_property")).toBe(true);
  });
});

const local = [
  { version: "20260909090000", name: "sms_outbox_conversation_log_repair" },
  { version: "20260909100000", name: "atomic_lease_action_events" },
  { version: "20260909110000", name: "action_event_sms_deferred_until" },
  { version: "20260909210000", name: "scope_application_fee_waiver_codes_to_property" },
];

describe("name-based migration parity", () => {
  it("reports exact name parity as unambiguous", () => {
    const result = diffMigrations(local, local);
    expect(result).toEqual({ missing: [], extra: [], problems: [] });
    expect(hasFatalMigrationDrift(result)).toBe(false);
  });

  it("treats the same name under a different version as applied", () => {
    const applied = local.map((row, index) => ({ ...row, version: `2027010100000${index}` }));
    expect(diffMigrations(local, applied)).toEqual({ missing: [], extra: [], problems: [] });
  });

  it("treats a different name under the same version as missing and unresolved", () => {
    const applied = local.map((row) => ({ ...row }));
    applied[3] = { ...applied[3]!, name: "bundled_history" };
    const result = diffMigrations(local, applied);
    expect(result.missing).toEqual([local[3]]);
    expect(result.extra).toEqual([applied[3]]);
    expect(result.problems).toEqual([]);
  });

  it("reports genuinely absent repo migrations", () => {
    const result = diffMigrations(local, [local[0]!]);
    expect(result.missing.map((row) => row.name)).toEqual([
      "atomic_lease_action_events",
      "action_event_sms_deferred_until",
      "scope_application_fee_waiver_codes_to_property",
    ]);
    expect(result.extra).toEqual([]);
  });

  it("reports an extra-only legacy bundle without inventing drift", () => {
    const bundle = { version: "20260909999999", name: "legacy_production_bundle" };
    const result = diffMigrations(local, [...local, bundle]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([bundle]);
    expect(hasFatalMigrationDrift(result)).toBe(false);
  });

  it("does not use a legacy bundle to satisfy a missing repo name", () => {
    const bundle = { version: local[3]!.version, name: "legacy_production_bundle" };
    const result = diffMigrations(local, [...local.slice(0, 3), bundle]);
    expect(result.missing).toEqual([local[3]]);
    expect(result.extra).toEqual([bundle]);
    expect(hasFatalMigrationDrift(result)).toBe(true);
  });

  it.each([
    {
      label: "empty name",
      rows: [{ version: "20260909090000", name: "" }],
      kind: "invalid-name",
    },
    {
      label: "whitespace-only name",
      rows: [{ version: "20260909090000", name: "   " }],
      kind: "invalid-name",
    },
    {
      label: "duplicate name",
      rows: [
        { version: "20260909090000", name: "same_name" },
        { version: "20260909090001", name: "same_name" },
      ],
      kind: "duplicate-name",
    },
    {
      label: "duplicate version",
      rows: [
        { version: "20260909090000", name: "first_name" },
        { version: "20260909090000", name: "second_name" },
      ],
      kind: "duplicate-version",
    },
  ])("fails closed on a database $label", ({ rows, kind }) => {
    const result = diffMigrations(local, rows);
    expect(result.problems).toEqual(expect.arrayContaining([expect.objectContaining({ source: "database", kind })]));
    expect(hasFatalMigrationDrift(result)).toBe(true);
  });

  it("fails closed on duplicate repo names too", () => {
    const duplicatedLocal = [...local, { version: "20260909220000", name: local[0]!.name }];
    const result = diffMigrations(duplicatedLocal, local);
    expect(result.problems).toEqual([
      expect.objectContaining({ source: "repo", kind: "duplicate-name", name: local[0]!.name }),
    ]);
  });
});

describe("target binding before database I/O", () => {
  const pooler = "aws-1-us-west-2.pooler.supabase.com";

  it.each(Object.entries(TARGET_PROJECT_REFS))(
    "accepts the %s project's direct and pooler credential shapes",
    (target, projectRef) => {
      expect(validateTargetConnection(target, `postgresql://postgres:secret@db.${projectRef}.supabase.co/postgres`)).toEqual({ ok: true });
      expect(validateTargetConnection(target, `postgresql://postgres.${projectRef}:secret@${pooler}/postgres`)).toEqual({ ok: true });
      expect(validateTargetConnection(target, `postgresql://cli_login_postgres.${projectRef}:secret@${pooler}/postgres`)).toEqual({ ok: true });
    },
  );

  it("rejects a valid credential for the wrong named target", () => {
    const url = `postgresql://postgres.${TARGET_PROJECT_REFS.production}:secret@${pooler}/postgres`;
    expect(validateTargetConnection("staging", url)).toEqual({ ok: false, reason: "target-mismatch" });
  });

  it("rejects forged project usernames on non-Supabase hosts", () => {
    const url = `postgresql://postgres.${TARGET_PROJECT_REFS.staging}:secret@127.0.0.1:5432/postgres`;
    expect(validateTargetConnection("staging", url)).toEqual({ ok: false, reason: "target-mismatch" });
  });

  it("rejects unknown targets and malformed credentials", () => {
    expect(validateTargetConnection("preview", "postgresql://postgres:secret@localhost/postgres")).toEqual({ ok: false, reason: "unknown-target" });
    expect(validateTargetConnection("staging", "not a database URL")).toEqual({ ok: false, reason: "malformed-url" });
  });

  it("keeps untargeted valid URLs available for local diagnostics", () => {
    expect(validateTargetConnection("", "postgresql://postgres:secret@127.0.0.1:5432/postgres")).toEqual({ ok: true });
  });

  it("permits known TLS options but rejects endpoint override query parameters", () => {
    const base = `postgresql://postgres.${TARGET_PROJECT_REFS.staging}:secret@${pooler}/postgres`;
    expect(validateTargetConnection("staging", `${base}?sslmode=require`)).toEqual({ ok: true });
    for (const query of ["host=evil.test", "hostaddr=127.0.0.1", "user=postgres", "port=1", "database=other", "service=evil"]) {
      expect(validateTargetConnection("staging", `${base}?${query}`)).toEqual({ ok: false, reason: "malformed-url" });
    }
  });
});

describe("argument parsing", () => {
  it("distinguishes an absent target from explicit valid flags", () => {
    expect(parseArguments([])).toEqual({ ok: true, target: "", dbUrl: "" });
    expect(parseArguments(["--target=staging", "--db-url", "postgresql://postgres@localhost/db"])).toEqual({
      ok: true,
      target: "staging",
      dbUrl: "postgresql://postgres@localhost/db",
    });
  });

  it.each([
    ["missing target", ["--target"]],
    ["empty target", ["--target="]],
    ["duplicate target", ["--target", "staging", "--target", "production"]],
    ["missing URL", ["--db-url"]],
    ["empty URL", ["--db-url="]],
    ["duplicate URL", ["--db-url", "postgresql://postgres@localhost/a", "--db-url", "postgresql://postgres@localhost/b"]],
    ["unknown flag", ["--apply"]],
    ["positional argument", ["staging"]],
  ])("rejects %s", (_label, args) => {
    expect(parseArguments(args)).toEqual({ ok: false, reason: "invalid-arguments" });
  });
});

describe("CLI exit and redaction behavior", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, ["scripts/check-migration-parity.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, SUPABASE_DB_URL: "", POSTGRES_URL: "", DATABASE_URL: "", ...env },
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it("exits 2 and never reads as a pass when no URL is available", () => {
    const result = run([]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("NOT CHECKED");
    expect(result.output).not.toContain("migration parity: OK");
  });

  it("rejects an unknown target before needing a URL", () => {
    const result = run(["--target", "preview"]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("unknown target");
  });

  it.each([
    ["--target"],
    ["--target="],
    ["--db-url"],
    ["--db-url="],
    ["--target", "staging", "--target", "production"],
    ["--unknown"],
  ])("rejects malformed CLI arguments before I/O: %j", (...args) => {
    const result = run(args);
    expect(result.code).toBe(2);
    expect(result.output).toContain("invalid command arguments");
  });

  it("rejects endpoint override query parameters before I/O", () => {
    const secret = "query-secret";
    const url = `postgresql://postgres.${TARGET_PROJECT_REFS.staging}:${secret}@aws-1-us-west-2.pooler.supabase.com/postgres?host=127.0.0.1`;
    const result = run(["--target", "staging", "--db-url", url]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("malformed database URL");
    expect(result.output).not.toContain(secret);
  });

  it("rejects a wrong target without attempting the supplied local socket", () => {
    const secret = "wrong-target-secret";
    const result = run([
      "--target",
      "staging",
      "--db-url",
      `postgresql://postgres.${TARGET_PROJECT_REFS.production}:${secret}@127.0.0.1:1/postgres`,
    ]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("connection does not match target");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain("could not read");
  });

  it("rejects malformed credentials without disclosing them", () => {
    const secret = "malformed-secret";
    const result = run(["--target", "production", "--db-url", `not-a-url-${secret}`]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("malformed database URL");
    expect(result.output).not.toContain(secret);
  });

  it("redacts driver errors for an unreachable untargeted local database", () => {
    const secret = "driver-secret";
    const url = `postgresql://postgres:${secret}@127.0.0.1:1/postgres`;
    const result = run(["--db-url", url]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("NOT CHECKED");
    expect(result.output).toContain("details and driver errors were suppressed");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain(url);
  });
}, 30_000);
