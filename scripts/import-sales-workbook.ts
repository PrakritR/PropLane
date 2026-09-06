import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { prepareSalesWorkbookMigration } from "../src/lib/sales-migration/source";
import { validateMigration } from "../src/lib/sales-migration/model";
import { executeSalesMigration, previewSalesMigration } from "../src/lib/sales-migration/server";

let reportPath: string | undefined;
function privateReport(value: unknown) {
  if (!reportPath) return;
  writeFileSync(reportPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(reportPath, 0o600);
  console.log(`report: ${JSON.stringify(reportPath)}`);
}
const help = "Prepare: node scripts/import-sales-workbook.mjs --prepare SOURCE_MAPPING_FILE --out DRAFT_FILE. Preview/execute: node scripts/import-sales-workbook.mjs --plan FILE [--write --confirm DIGEST] [--out FILE] [--help]; set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MANAGER_USER_ID. Writes also require ALLOW_IMPORT_TARGET=<project-ref>.";
async function main() {
  let values;
  try { ({ values } = parseArgs({ options: { prepare: { type: "string" }, plan: { type: "string" }, write: { type: "boolean" }, confirm: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } }, strict: true, allowPositionals: false })); }
  catch { console.log(`error: Invalid arguments\nhelp: ${JSON.stringify(help)}`); process.exitCode = 2; return; }
  if (values.help) { console.log(`help: ${JSON.stringify(help)}`); return; }
  reportPath = values.out;
  if (values.prepare) {
    if (!values.out || values.plan || values.write || values.confirm) throw new Error("Prepare needs --out and cannot execute a plan");
    const draft = prepareSalesWorkbookMigration(JSON.parse(readFileSync(values.prepare, "utf8")));
    validateMigration(draft);
    privateReport(draft);
    console.log(`mode: prepare\nphysical_rooms: ${draft.inventory.reduce((sum, p) => sum + p.roomCount, 0)}\nunresolved: ${draft.unresolved.length}`);
    return;
  }
  if (!values.plan || (values.write && !values.confirm)) { console.log(`error: A plan and an explicit reviewed digest for writes are required\nhelp: ${JSON.stringify(help)}`); process.exitCode = 2; return; }
  const plan = validateMigration(JSON.parse(readFileSync(values.plan, "utf8")));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const owner = process.env.MANAGER_USER_ID?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(owner) || !serviceKey) throw new Error("Configure the target environment and manager id");
  const target = /^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/.exec(url)?.[1];
  if (!target) throw new Error("Use a canonical HTTPS database project URL");
  if (values.write && process.env.ALLOW_IMPORT_TARGET !== target) throw new Error("ALLOW_IMPORT_TARGET must name the reviewed target project");
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const preview = await previewSalesMigration(db, owner, plan);
  const result = values.write ? await executeSalesMigration(db, owner, plan, values.confirm!) : { digest: preview.digest, physicalRooms: preview.physicalRooms, unresolved: preview.unresolved };
  console.log(`mode: ${values.write ? "execute" : "preview"}\ntarget: ${target}\ndigest: ${result.digest}\nphysical_rooms: ${result.physicalRooms}`);
  if ("completed" in result) {
    console.log(`completed: ${result.completed}\nskipped: ${result.skipped}\nblocked: ${result.blocked.length}`);
    if (result.blocked.length) process.exitCode = 1;
  } else console.log(`unresolved: ${result.unresolved}`);
  if (values.out) privateReport(result);
  else console.log('help: "Use --out FILE for the reconciliation details; private source content is omitted from stdout."');
}
main().catch(error => {
  privateReport({ error: error instanceof Error ? error.message : "Import failed", ...(error?.name === "ZodError" ? { issues: error.issues } : {}) });
  // Never dump a source payload or a database error that might contain resident data.
  console.log(`error: ${error?.name === "ZodError" ? "Plan schema validation failed" : "Import could not complete"}\nhelp: "Check the version-2 plan, target ownership and source reconciliation. No implicit retries were made."`);
  process.exitCode = 1;
});
