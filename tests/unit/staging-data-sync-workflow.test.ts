import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/staging-data-sync.yml", "utf8");
const script = readFileSync("scripts/sync-prod-to-staging.mjs", "utf8");

describe("scheduled production-to-staging refresh", () => {
  it("runs twice daily from staging and serializes writes", () => {
    expect(workflow).toContain('cron: "23 */12 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: staging-production-data-refresh");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("ref: staging");
    expect(workflow).toContain("environment: staging-data-sync");
  });

  it("fails closed on missing or wrong staging credentials", () => {
    expect(workflow).toContain('test -n "$SUPABASE_ACCESS_TOKEN"');
    expect(workflow).toContain('test "$NEXT_PUBLIC_SUPABASE_URL" = "https://xwszcafaontidfgznlxd.supabase.co"');
    expect(workflow).toContain("NEXT_PUBLIC_SUPABASE_URL: https://xwszcafaontidfgznlxd.supabase.co");
    expect(workflow).not.toContain("secrets.STAGING_SUPABASE_URL");
    expect(workflow).not.toContain("PROD_DB_PASSWORD");
    expect(workflow).not.toContain("--full-replace");
  });

  it("pins compatible tooling and always removes private dumps", () => {
    expect(workflow).toContain("supabase@2.117.0");
    expect(workflow).toContain("postgresql-client-17");
    expect(workflow).toContain("umask 077");
    expect(workflow).toMatch(/Remove local refresh files[\s\S]*if: always\(\)/);
    expect(script).toContain("process.umask(0o077)");
    expect(script).toMatch(/finally \{[\s\S]*cleanupPrivateDumpFiles\(\)/);
    expect(script).toMatch(/writeFileSync\(SNAPSHOT_MARK[\s\S]*STAGING_SYNC_FRESHNESS_FILE/);
  });

  it("removes private dump files when a guard fails", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "axis-staging-sync-test-"));
    const scriptsDir = join(fixtureRoot, "scripts");
    const libDir = join(scriptsDir, "lib");
    const dir = join(fixtureRoot, ".staging-prod-sync");
    const file = join(dir, "prod-public.sql");
    mkdirSync(libDir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync("scripts/sync-prod-to-staging.mjs", join(scriptsDir, "sync-prod-to-staging.mjs"));
    copyFileSync("scripts/lib/prod-staging-merge.mjs", join(libDir, "prod-staging-merge.mjs"));
    writeFileSync(file, "private fixture");
    const result = spawnSync(process.execPath, [join(scriptsDir, "sync-prod-to-staging.mjs")], {
      encoding: "utf8",
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "https://wrong.example" },
    });
    expect(result.status).toBe(1);
    expect(existsSync(file)).toBe(false);
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
});
