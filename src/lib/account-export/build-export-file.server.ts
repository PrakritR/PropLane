import "server-only";
import { strToU8, zipSync } from "fflate";
import type { ManagerExport } from "@/lib/account-export/collect-manager-export.server";
import { EXPORT_FILE_EXTENSION, encryptExportPayload } from "@/lib/account-export/export-crypto";

/**
 * Inside the encrypted container is an ordinary zip: `manifest.json` plus one
 * `tables/<table>.json` per table (an array of rows). Zip first so the manager gets
 * something every tool can open once they have decrypted it, and so the encrypted blob is
 * a fraction of the JSON size.
 */
export function buildExportZip(exportData: ManagerExport): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(exportData.manifest, null, 2)),
  };
  for (const [table, rows] of Object.entries(exportData.tables)) {
    entries[`tables/${table}.json`] = strToU8(JSON.stringify(rows, null, 2));
  }
  return zipSync(entries, { level: 6 });
}

export function buildEncryptedExportFile(exportData: ManagerExport, password: string): Buffer {
  return encryptExportPayload(buildExportZip(exportData), password);
}

/** `proplane-export-2026-09-07.proplane` — date only, never the manager id or email. */
export function exportFileName(now: Date = new Date()): string {
  return `proplane-export-${now.toISOString().slice(0, 10)}${EXPORT_FILE_EXTENSION}`;
}
