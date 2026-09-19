import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PRIVATE_ROOT,
  throwPrivateCliFailure,
  writePrivateCliFailureDiagnostic,
} from "../../scripts/release-conversation-schema-reconciliation.mjs";

const context = {
  projectRef: "emstjswhotsnyksqhqyf",
  phase: "apply" as const,
  identity: "20260919161700_mark_portal_inbox_source_read_resident_scope",
};

const privateRootStat = {
  mode: 0o40700,
  isDirectory: () => true,
  isSymbolicLink: () => false,
};

describe("private release CLI failure diagnostics", () => {
  it("writes unique exclusive 0600 artifacts directly beneath the verified private root", () => {
    const writes: Array<{ path: string; bytes: string; options: { mode: number; flag: string } }> = [];
    let nonce = 0;
    const operations = {
      lstatSync: () => privateRootStat,
      now: () => Date.parse("2026-09-19T18:00:00.000Z"),
      randomBytes: () => Buffer.alloc(16, ++nonce),
      writeFileSync: (path: string, bytes: string, options: { mode: number; flag: string }) => writes.push({ path, bytes, options }),
    };
    const result = { status: 1, signal: null, error: null, stdout: "private stdout", stderr: "private stderr" };

    const first = writePrivateCliFailureDiagnostic({ ...context, result }, operations);
    const second = writePrivateCliFailureDiagnostic({ ...context, result }, operations);

    expect(first).not.toBe(second);
    expect(dirname(first)).toBe(PRIVATE_ROOT);
    expect(dirname(second)).toBe(PRIVATE_ROOT);
    expect(first).not.toContain("resident-read-");
    expect(first).not.toContain("manifest.json");
    expect(writes.map(write => write.options)).toEqual([
      { mode: 0o600, flag: "wx" },
      { mode: 0o600, flag: "wx" },
    ]);
    expect(JSON.parse(writes[0].bytes)).toEqual({
      format: 1,
      ...context,
      recordedAt: "2026-09-19T18:00:00.000Z",
      process: { status: 1, signal: null, error: null },
      stdout: "private stdout",
      stderr: "private stderr",
    });
  });

  it("records only fixed process metadata and captured streams, without an environment dump", () => {
    let bytes = "";
    const secret = "SUPABASE_ACCESS_TOKEN=not-for-the-terminal";
    const result = {
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error(`spawn failed near ${secret}`), { code: "ETIMEDOUT", errno: -60, syscall: "spawn" }),
      stdout: secret,
      stderr: "private SQL detail",
      env: { SUPABASE_ACCESS_TOKEN: secret },
    };
    writePrivateCliFailureDiagnostic({ ...context, phase: "dry-run", result }, {
      lstatSync: () => privateRootStat,
      now: () => 0,
      randomBytes: () => Buffer.alloc(16, 3),
      writeFileSync: (_path: string, value: string) => { bytes = value; },
    });

    const artifact = JSON.parse(bytes);
    expect(artifact.process).toEqual({
      status: null,
      signal: "SIGTERM",
      error: { name: "Error", message: `spawn failed near ${secret}`, code: "ETIMEDOUT", errno: -60, syscall: "spawn" },
    });
    expect(artifact.stdout).toBe(secret);
    expect(artifact.stderr).toBe("private SQL detail");
    expect(artifact).not.toHaveProperty("env");
  });

  it("keeps a failed CLI failed while exposing only the safe private artifact path", () => {
    const secret = "token-and-private-SQL";
    const result = { status: 1, signal: null, error: new Error(secret), stdout: secret, stderr: secret };
    const operations = {
      lstatSync: () => privateRootStat,
      now: () => 1,
      randomBytes: () => Buffer.alloc(16, 4),
      writeFileSync: () => undefined,
    };

    expect(() => throwPrivateCliFailure(context, result, operations)).toThrow(/private diagnostic: \/Users\/akhilvemuri\/\.local\/state\/proplane-release\//);
    try { throwPrivateCliFailure(context, result, operations); }
    catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("stdout");
      expect(String(error)).not.toContain("stderr");
    }
  });

  it("fails closed with safe wording when private logging cannot complete", () => {
    const secret = "credential-like-private-output";
    const result = { status: 1, signal: null, error: null, stdout: secret, stderr: secret };
    const operations = {
      lstatSync: () => privateRootStat,
      randomBytes: () => Buffer.alloc(16, 5),
      writeFileSync: () => { throw new Error(`disk failure ${secret}`); },
    };

    expect(() => throwPrivateCliFailure(context, result, operations)).toThrow("Supported CLI operation failed; private diagnostic unavailable");
    try { throwPrivateCliFailure(context, result, operations); }
    catch (error) { expect(String(error)).not.toContain(secret); }
  });

  it("refuses logging when the fixed private root is not a real 0700 directory", () => {
    expect(() => writePrivateCliFailureDiagnostic({ ...context, result: { status: 1 } }, {
      lstatSync: () => ({ ...privateRootStat, mode: 0o40755 }),
      randomBytes: () => Buffer.alloc(16, 6),
      writeFileSync: () => undefined,
    })).toThrow(/private directory/);
  });
});
