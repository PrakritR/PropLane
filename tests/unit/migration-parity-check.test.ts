// The gate that would have caught 2026-09-10, tested — because an untested gate
// is exactly what let that day happen. `20260909210000` merged and shipped to
// production while neither staging nor production had ever run it, and every
// existing check stayed green: unit tests mock Supabase, so nothing compared a
// query against the schema it would actually meet.
//
// The comparison, not the database plumbing, is where the verdict is made, so
// that is what is pinned here — including the real repo's own migration
// filenames, so a badly named file is caught before it can be silently ignored.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { diffMigrations, parseMigrationFileNames } from "../../scripts/check-migration-parity.mjs";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("reading the repo's own migrations", () => {
  it("parses every .sql file in supabase/migrations", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const parsed = parseMigrationFileNames(files);
    // A file the parser silently skips is a migration this gate would never
    // notice was unapplied — the whole failure mode, one level down.
    const skipped = files.filter((f) => !parsed.some((p) => f.startsWith(`${p.version}_`)));
    expect(skipped, "migration filenames must be <14-digit version>_<name>.sql").toEqual([]);
    expect(parsed.length).toBe(files.length);
  });

  it("keeps versions unique and ordered", () => {
    const parsed = parseMigrationFileNames(readdirSync(MIGRATIONS_DIR));
    const versions = parsed.map((p) => p.version);
    expect(new Set(versions).size, "two migrations share a version").toBe(versions.length);
    expect([...versions].sort()).toEqual(versions);
  });

  it("includes the migration whose absence broke the waiver code", () => {
    const parsed = parseMigrationFileNames(readdirSync(MIGRATIONS_DIR));
    expect(parsed.some((p) => p.version === "20260909210000")).toBe(true);
  });
});

const local = [
  { version: "20260909090000", name: "sms_outbox_conversation_log_repair" },
  { version: "20260909100000", name: "atomic_lease_action_events" },
  { version: "20260909110000", name: "action_event_sms_deferred_until" },
  { version: "20260909210000", name: "scope_application_fee_waiver_codes_to_property" },
];

describe("the verdict", () => {
  it("reports nothing when the database is level with the repo", () => {
    expect(diffMigrations(local, local)).toEqual({ missing: [], extra: [] });
  });

  it("names exactly what production was missing on Sep 10", () => {
    // Production's real ledger that morning: it stopped at 20260909090000.
    const applied = [local[0]!];
    const { missing, extra } = diffMigrations(local, applied);
    expect(missing.map((m) => m.version)).toEqual([
      "20260909100000",
      "20260909110000",
      "20260909210000",
    ]);
    expect(extra).toEqual([]);
  });

  it("treats a version the database has and the repo does not as non-fatal", () => {
    const applied = [...local, { version: "20260101000000", name: "squashed_baseline" }];
    const { missing, extra } = diffMigrations(local, applied);
    expect(missing).toEqual([]);
    expect(extra.map((e) => e.version)).toEqual(["20260101000000"]);
  });

  it("does not mistake an equal COUNT for parity", () => {
    // Same number of rows either side, one substituted — a length comparison
    // would have called this in sync.
    const applied = [...local.slice(0, 3), { version: "20260909999999", name: "something_else" }];
    const { missing, extra } = diffMigrations(local, applied);
    expect(missing.map((m) => m.version)).toEqual(["20260909210000"]);
    expect(extra.map((e) => e.version)).toEqual(["20260909999999"]);
  });
});

describe("the CLI's exit codes, which ship-preflight branches on", () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      const stdout = execFileSync("node", ["scripts/check-migration-parity.mjs", ...args], {
        encoding: "utf8",
        // Strip any inherited connection string so "no URL" really means none.
        env: { ...process.env, SUPABASE_DB_URL: "", POSTGRES_URL: "", DATABASE_URL: "", ...env },
      });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("exits 2 and says so when there is no database to check", () => {
    const { code, stdout } = run([]);
    expect(code).toBe(2);
    expect(stdout).toContain("NOT CHECKED");
    // "Not checked" must never read as a pass.
    expect(stdout).not.toContain("OK");
  });

  it("exits 2 without echoing the connection string when the database is unreachable", () => {
    const secret = "s3cret-should-never-print";
    const { code, stdout } = run([
      "--db-url",
      `postgresql://postgres:${secret}@127.0.0.1:1/postgres`,
      "--target",
      "staging",
    ]);
    expect(code).toBe(2);
    expect(stdout).toContain("NOT CHECKED");
    expect(stdout).toContain("staging");
    expect(stdout).not.toContain(secret);
  });
}, 30_000);
