import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A reviewer-readable transcript of the real oversight requests a test made.
 *
 * `admin-oversight-manager-routes.test.ts` drives most manager-portal GETs from one
 * table and writes `manager-portal-routes-oversight.txt`. The routes whose fixtures are
 * too specific to share that table (property-records, lease-pipeline, schedule-records)
 * live in their own files and use this to write the same shape of transcript, so every
 * route named in the change has an artifact a reviewer can read, not just an assertion.
 */
export function oversightTranscript(file: string, header: string[]) {
  const lines: string[] = [];
  return {
    /** One real request and its real response. */
    record(path: string, query: string, viewer: string, status: number, rows: readonly string[]) {
      lines.push(
        `GET ${path}${query}`.padEnd(58) + `(viewer: ${viewer})\n` + `  ${status} rows: ${JSON.stringify(rows)}`,
      );
    },
    write() {
      const out = process.env.EVIDENCE_DIR ?? join(tmpdir(), "proplane-comms-isolation-evidence");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, file), [...header, "", ...lines, ""].join("\n"));
    },
  };
}
