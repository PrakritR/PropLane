import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXPORT_FILE_MAGIC,
  ExportDecryptError,
  decryptExportPayload,
  encryptExportPayload,
} from "@/lib/account-export/export-crypto";
import { buildEncryptedExportFile, buildExportZip, exportFileName } from "@/lib/account-export/build-export-file.server";
import type { ManagerExport } from "@/lib/account-export/collect-manager-export.server";

const PASSWORD = "correct horse battery staple";
const PLAINTEXT = new TextEncoder().encode(JSON.stringify({ hello: "export", rows: [1, 2, 3] }));

const sampleExport: ManagerExport = {
  manifest: {
    format: "proplane-export",
    schemaVersion: 1,
    exportedAt: "2026-09-07T12:00:00.000Z",
    managerId: "mgr-1",
    tableCount: 2,
    rowCount: 3,
    tables: { manager_property_records: { rows: 2 }, ledger_entries: { rows: 1 } },
    excludedKeyPatterns: ["ssn"],
  },
  tables: {
    manager_property_records: [{ id: "p1", name: "12 Elm" }, { id: "p2", name: "9 Oak" }],
    ledger_entries: [{ id: "l1", amount_cents: 120000 }],
  },
};

const scratch = mkdtempSync(path.join(tmpdir(), "proplane-export-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("export container", () => {
  it("round-trips under the right password and is unreadable without it", () => {
    const file = encryptExportPayload(PLAINTEXT, PASSWORD);

    expect(file.subarray(0, 8).toString("ascii")).toBe(EXPORT_FILE_MAGIC);
    // The payload must not be visible in the clear anywhere in the file.
    expect(file.toString("latin1")).not.toContain("hello");
    expect(file.toString("latin1")).not.toContain("export");

    expect(Buffer.from(decryptExportPayload(file, PASSWORD))).toEqual(Buffer.from(PLAINTEXT));
  });

  it("refuses the wrong password, an altered byte, and a foreign file", () => {
    const file = encryptExportPayload(PLAINTEXT, PASSWORD);

    expect(() => decryptExportPayload(file, "correct horse battery stapl3")).toThrow(ExportDecryptError);

    const flippedBody = Buffer.from(file);
    flippedBody[flippedBody.length - 1] ^= 0x01;
    expect(() => decryptExportPayload(flippedBody, PASSWORD)).toThrow(ExportDecryptError);

    // The KDF parameters are authenticated too: weakening them fails, it does not derive.
    const weakened = Buffer.from(file);
    weakened[9] = 10;
    expect(() => decryptExportPayload(weakened, PASSWORD)).toThrow(ExportDecryptError);

    expect(() => decryptExportPayload(Buffer.from("PKnot-an-export"), PASSWORD)).toThrow(
      /Not a PropLane export/,
    );
  });

  it("never reuses a salt or iv, so the same data encrypts differently each time", () => {
    const a = encryptExportPayload(PLAINTEXT, PASSWORD);
    const b = encryptExportPayload(PLAINTEXT, PASSWORD);
    expect(a.subarray(12, 40)).not.toEqual(b.subarray(12, 40));
    expect(a.subarray(56)).not.toEqual(b.subarray(56));
  });

  it("refuses to seal under a password shorter than the minimum", () => {
    expect(() => encryptExportPayload(PLAINTEXT, "short")).toThrow(/at least 12/);
  });
});

describe("export zip", () => {
  it("carries manifest.json and one JSON file per table", () => {
    const zip = unzipSync(buildExportZip(sampleExport));
    expect(Object.keys(zip).sort()).toEqual([
      "manifest.json",
      "tables/ledger_entries.json",
      "tables/manager_property_records.json",
    ]);
    expect(JSON.parse(strFromU8(zip["manifest.json"]))).toEqual(sampleExport.manifest);
    expect(JSON.parse(strFromU8(zip["tables/manager_property_records.json"]))).toEqual(
      sampleExport.tables.manager_property_records,
    );
  });

  it("names the file by date only", () => {
    expect(exportFileName(new Date("2026-09-07T23:59:00Z"))).toBe("proplane-export-2026-09-07.proplane");
  });

  /**
   * The whole point of the format is that a manager who has left can open it with nothing
   * but Node. Run the real script against a real file rather than trusting the two
   * implementations to agree by inspection.
   */
  it("opens with scripts/open-proplane-export.mjs and nothing else", () => {
    const filePath = path.join(scratch, "proplane-export-2026-09-07.proplane");
    writeFileSync(filePath, buildEncryptedExportFile(sampleExport, PASSWORD));
    const outDir = path.join(scratch, "opened");

    const stdout = execFileSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "open-proplane-export.mjs"), filePath, "--extract", outDir],
      { env: { ...process.env, PROPLANE_EXPORT_PASSWORD: PASSWORD }, encoding: "utf8" },
    );

    expect(stdout).toContain("3 rows across 2 tables");
    expect(JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"))).toEqual(sampleExport.manifest);
    expect(JSON.parse(readFileSync(path.join(outDir, "tables", "ledger_entries.json"), "utf8"))).toEqual(
      sampleExport.tables.ledger_entries,
    );

    let failed: { status?: number; stderr?: string } | null = null;
    try {
      execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "open-proplane-export.mjs"), filePath], {
        env: { ...process.env, PROPLANE_EXPORT_PASSWORD: "not the password!" },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      failed = error as { status?: number; stderr?: string };
    }
    expect(failed?.status).toBe(1);
    expect(failed?.stderr).toMatch(/Wrong password/);
  });
});
