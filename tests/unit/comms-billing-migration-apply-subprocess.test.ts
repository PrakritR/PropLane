import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const BUNDLE_SHA256 = "c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff";
const WAIVER = "2026-09-11-production-comms-billing";
const STAGING = "xwszcafaontidfgznlxd";
const PRODUCTION = "qahnczmilgptcedaqype";
const SOURCE_FILES = [
  "20260910140000_manager_communication_credits.sql",
  "20260910160000_comms_credit_alerts.sql",
  "20260910170000_manager_billing_customer.sql",
  "20260910180000_comms_wallet_snapshots.sql",
  "20260910190000_sms_outbox_campaign_budget.sql",
];

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function executable(path: string, source: string) {
  writeFileSync(path, source, { mode: 0o700 });
}

function makeFixture(status: "DRAFT" | "APPROVED" | "CONSUMED" = "DRAFT") {
  const root = mkdtempSync(join(tmpdir(), "comms-runner-subprocess-"));
  fixtures.push(root);
  for (const path of [
    "bin",
    "home",
    "docs/waivers",
    "scripts/lib",
    "scripts/rollouts/2026-09-11-comms-billing",
    "supabase/migrations",
  ]) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });

  cpSync(join(ROOT, "scripts/apply-20260911-comms-billing-migrations.mjs"), join(root, "scripts/apply-20260911-comms-billing-migrations.mjs"));
  cpSync(join(ROOT, "scripts/prepare-20260911-comms-billing-migrations.mjs"), join(root, "scripts/prepare-20260911-comms-billing-migrations.mjs"));
  cpSync(join(ROOT, "scripts/lib/supabase-root-2021.crt"), join(root, "scripts/lib/supabase-root-2021.crt"));
  cpSync(
    join(ROOT, "scripts/rollouts/2026-09-11-comms-billing/20260911160000_comms_credit_recovery_guards.sql"),
    join(root, "scripts/rollouts/2026-09-11-comms-billing/20260911160000_comms_credit_recovery_guards.sql"),
  );
  for (const file of SOURCE_FILES) cpSync(join(ROOT, "supabase/migrations", file), join(root, "supabase/migrations", file));

  executable(join(root, "bin/git"), `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const spec = process.argv[3] || "";
const split = spec.indexOf(":");
if (process.argv[2] !== "show" || split < 0) process.exit(8);
process.stdout.write(readFileSync(join(process.cwd(), spec.slice(split + 1))));
`);
  executable(join(root, "bin/npx"), `#!/usr/bin/env node
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const root = dirname(dirname(__filename));
const config = join(process.cwd(), "supabase/config.toml");
writeFileSync(join(root, "npx-record.json"), JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env).sort(),
  hostilePgHost: process.env.PGHOST ?? null, hostileSslMode: process.env.PGSSLMODE ?? null,
  cwdMode: statSync(process.cwd()).mode & 0o777,
  supabaseMode: statSync(join(process.cwd(), "supabase")).mode & 0o777,
  configMode: statSync(config).mode & 0o777,
  config: readFileSync(config, "utf8"),
}));
if (readFileSync(join(root, "fake-mode"), "utf8").trim() === "success") {
  process.stdout.write('export PGHOST="db.${STAGING}.supabase.co"\\nexport PGPORT="5432"\\nexport PGUSER="cli_login_postgres"\\nexport PGPASSWORD="fixture-password"\\nexport PGDATABASE="postgres"\\n');
  process.exit(0);
}
process.stderr.write("FAKE_SECRET_FROM_CLI");
process.exit(9);
`);
  writeFileSync(join(root, "fake-mode"), "fail\n", { mode: 0o600 });

  const runner = join(root, "scripts/apply-20260911-comms-billing-migrations.mjs");
  const digest = createHash("sha256").update(readFileSync(runner)).digest("hex");
  const statusLine = status === "CONSUMED" ? "APPROVED - CONSUMED" : status;
  writeFileSync(
    join(root, `docs/waivers/${WAIVER}.md`),
    `# Fixture waiver\n\nStatus: **${statusLine}**\n\nRunner SHA-256: \`${digest}\`\n`,
    { mode: 0o600 },
  );
  return { root, runner: realpathSync(runner), digest };
}

function run(fixture: ReturnType<typeof makeFixture>, args: string[]) {
  return spawnSync(process.execPath, [fixture.runner, ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: `${join(fixture.root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(fixture.root, "home"),
      USER: "fixture-user",
      LOGNAME: "fixture-user",
      LANG: "C",
      SUPABASE_ACCESS_TOKEN: "fixture-access-token",
      PGHOST: "hostile.invalid",
      PGSSLMODE: "disable",
      PGOPTIONS: "-c search_path=hostile",
      DATABASE_URL: "postgres://should-not-leak",
      DOTENV_CONFIG_PATH: "/tmp/hostile.env",
    },
  });
}

function record(fixture: ReturnType<typeof makeFixture>) {
  return JSON.parse(readFileSync(join(fixture.root, "npx-record.json"), "utf8")) as {
    args: string[];
    cwd: string;
    envKeys: string[];
    hostilePgHost: string | null;
    hostileSslMode: string | null;
    cwdMode: number;
    supabaseMode: number;
    configMode: number;
    config: string;
  };
}

describe("communication billing apply subprocess boundary", () => {
  it("lets only an exact APPROVED copied waiver reach the pinned private CLI boundary", () => {
    const fixture = makeFixture("APPROVED");
    const result = run(fixture, ["--apply-production", "--bundle-sha256", BUNDLE_SHA256, "--waiver", WAIVER]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("credential acquisition failed");
    expect(result.stderr).not.toContain("FAKE_SECRET_FROM_CLI");
    expect(result.stderr).not.toContain("fixture-access-token");
    const invocation = record(fixture);
    expect(invocation.args).toEqual([
      "-y", "supabase@2.117.0", "db", "dump", "--project-ref", PRODUCTION,
      "--data-only", "--schema", "public", "--dry-run", "--yes",
    ]);
    expect(invocation.cwdMode).toBe(0o700);
    expect(invocation.supabaseMode).toBe(0o700);
    expect(invocation.configMode).toBe(0o600);
    expect(invocation.config).toBe('project_id = "comms-billing-login"\n');
    expect(invocation.hostilePgHost).toBeNull();
    expect(invocation.hostileSslMode).toBeNull();
    expect(invocation.envKeys).not.toEqual(expect.arrayContaining(["PGHOST", "PGSSLMODE", "PGOPTIONS", "DATABASE_URL", "DOTENV_CONFIG_PATH"]));
    expect(existsSync(invocation.cwd)).toBe(false);
  });

  it.each([
    ["DRAFT waiver", "DRAFT", ["--apply-production", "--bundle-sha256", BUNDLE_SHA256, "--waiver", WAIVER]],
    ["consumed waiver", "CONSUMED", ["--apply-production", "--bundle-sha256", BUNDLE_SHA256, "--waiver", WAIVER]],
    ["missing waiver acknowledgement", "APPROVED", ["--apply-production", "--bundle-sha256", BUNDLE_SHA256]],
    ["mixed acknowledgement order", "APPROVED", ["--apply-production", "--waiver", WAIVER, "--bundle-sha256", BUNDLE_SHA256]],
  ] as const)("refuses %s before credential acquisition", (_label, status, args) => {
    const fixture = makeFixture(status);
    const result = run(fixture, [...args]);
    expect(result.status).toBe(1);
    expect(existsSync(join(fixture.root, "npx-record.json"))).toBe(false);
  });

  it("refuses a copied waiver with the wrong runner digest before credential acquisition", () => {
    const fixture = makeFixture("APPROVED");
    const waiver = join(fixture.root, `docs/waivers/${WAIVER}.md`);
    writeFileSync(waiver, readFileSync(waiver, "utf8").replace(fixture.digest, "0".repeat(64)));
    const result = run(fixture, ["--apply-production", "--bundle-sha256", BUNDLE_SHA256, "--waiver", WAIVER]);
    expect(result.status).toBe(1);
    expect(existsSync(join(fixture.root, "npx-record.json"))).toBe(false);
  });

  it("refuses source, bundle, and CA drift in isolated copies", () => {
    const sourceFixture = makeFixture();
    writeFileSync(join(sourceFixture.root, "supabase/migrations", SOURCE_FILES[0]), `${readFileSync(join(sourceFixture.root, "supabase/migrations", SOURCE_FILES[0]), "utf8")}\n`);
    const sourceResult = run(sourceFixture, ["--preflight-staging"]);
    expect(sourceResult.status).toBe(1);
    expect(sourceResult.stderr).toContain(`Pinned source verification failed: ${SOURCE_FILES[0]}`);
    expect(existsSync(join(sourceFixture.root, "npx-record.json"))).toBe(false);

    const bundleFixture = makeFixture();
    writeFileSync(bundleFixture.runner, readFileSync(bundleFixture.runner, "utf8").replace(BUNDLE_SHA256, "0".repeat(64)));
    const bundleResult = run(bundleFixture, ["--preflight-staging"]);
    expect(bundleResult.status).toBe(1);
    expect(bundleResult.stderr).toContain("Communication billing migration bundle digest validation failed. No credentials, SQL, or database output is displayed.");
    expect(existsSync(join(bundleFixture.root, "npx-record.json"))).toBe(false);

    const caFixture = makeFixture();
    writeFileSync(join(caFixture.root, "fake-mode"), "success\n");
    writeFileSync(join(caFixture.root, "scripts/lib/supabase-root-2021.crt"), "not the pinned CA\n");
    const caResult = run(caFixture, ["--preflight-staging"]);
    expect(caResult.status).toBe(1);
    expect(caResult.stderr).toContain("TLS root validation failed");
    expect(caResult.stderr).not.toContain("fixture-password");
    const caInvocation = record(caFixture);
    expect(caInvocation.args).toContain(STAGING);
    expect(existsSync(caInvocation.cwd)).toBe(false);
  });
});
