import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertLocalPrerequisites } from "../../scripts/testing/comms-billing-migration-apply-local-harness.mjs";

describe("communication billing apply localhost transport harness", () => {
  it("runs only against a disposable localhost PostgreSQL cluster", () => {
    const result = spawnSync(process.execPath, ["scripts/testing/comms-billing-migration-apply-local-harness.mjs"], { encoding: "utf8", timeout: 90_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS: fixed runner real-pg commit/readback");
  }, 100_000);

  it("fails fast with local PostgreSQL and OpenSSL prerequisites", () => {
    const result = spawnSync(process.execPath, ["scripts/testing/comms-billing-migration-apply-local-harness.mjs"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: "/definitely-missing-local-harness-tools" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires PostgreSQL server tools (initdb and pg_ctl) and OpenSSL on PATH");
    expect(result.stderr).toContain("Missing or unusable: initdb");
  });

  it("probes PostgreSQL tools with --version and OpenSSL with its version subcommand", () => {
    const calls: Array<[string, string[]]> = [];

    assertLocalPrerequisites((tool: string, args: string[]) => {
      calls.push([tool, args]);
    });

    expect(calls).toEqual([
      ["initdb", ["--version"]],
      ["pg_ctl", ["--version"]],
      ["openssl", ["version"]],
    ]);
  });
});
