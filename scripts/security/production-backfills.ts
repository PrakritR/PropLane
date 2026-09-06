import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PRODUCTION_PROJECT, assertProductionUrl, connectProductionDatabase, productionDatabaseConfig } from "./production-database.mjs";
import { protectApplicantRecord } from "./applicant-backfill";
import { protectCosignerRecord } from "./cosigner-backfill";
import { protectCalendarTokens } from "./calendar-backfill";
import { migrateApplicationDocumentObject, type DocumentBackfillDatabase } from "./application-document-backfill";
import { APPLICATION_DOCUMENTS_BUCKET } from "../../src/lib/rental-application/application-photos";
import { applicationPhotoFolderKey } from "../../src/lib/rental-application/application-photos.server";
import { decryptApplicationDocumentBytes } from "../../src/lib/security/application-document-crypto.server";
import { boundedSnapshotJson, MAX_DOCUMENT_OBJECTS, MAX_ROWS_PER_TABLE, MAX_SNAPSHOT_BYTES, SNAPSHOT_TABLES,
  writeProductionSnapshot, type BackfillKind, type Snapshot } from "./production-backup";

export const SECURITY_MIGRATIONS = [
  "20260906020000_shared_rate_limits", "20260906030000_application_document_envelopes",
  "20260906031000_application_document_aliases", "20260906040000_sensitive_table_browser_privileges",
  "20260906050000_application_record_normalization",
] as const;

export function parseProductionBackfillArgs(args: string[]) {
  const [kind, ...flags] = args;
  if (!["applicant", "cosigner", "calendar", "document"].includes(kind)) throw new Error("Choose one supported backfill.");
  if (new Set(flags).size !== flags.length || flags.some((flag) => flag !== "--apply" &&
      flag !== `--confirm-project=${PRODUCTION_PROJECT}` && !flag.startsWith("--backup-dir="))) throw new Error("Unsupported operator arguments.");
  const dirs = flags.filter((flag) => flag.startsWith("--backup-dir="));
  if (dirs.length > 1) throw new Error("One backup directory is required.");
  const apply = flags.includes("--apply");
  const backupDirectory = dirs[0]?.slice("--backup-dir=".length);
  if (apply && (!flags.includes(`--confirm-project=${PRODUCTION_PROJECT}`) || !backupDirectory || !isAbsolute(backupDirectory))) {
    throw new Error("Apply requires exact production confirmation and an absolute private backup directory.");
  }
  if (!apply && flags.length) throw new Error("Dry run takes only the backfill name.");
  return { kind: kind as BackfillKind, apply, backupDirectory };
}

export async function verifyProductionMigrationHistory(db: DocumentBackfillDatabase) {
  for (const migration of SECURITY_MIGRATIONS) {
    const version = migration.slice(0, 14);
    const name = migration.slice(15);
    const expected = readFileSync(new URL(`../../supabase/migrations/${migration}.sql`, import.meta.url), "utf8");
    const result = await db.query("select name, statements from supabase_migrations.schema_migrations where version = $1", [version]);
    if (result.rows.length !== 1 || result.rows[0].name !== name || !Array.isArray(result.rows[0].statements) ||
        result.rows[0].statements.length !== 1 || result.rows[0].statements[0] !== expected) {
      throw new Error("Required security migration history is missing or differs from reviewed source.");
    }
  }
}

async function transaction(db: DocumentBackfillDatabase, apply: boolean) {
  await db.query(apply ? "begin isolation level repeatable read" : "begin isolation level repeatable read read only");
  await db.query("set local role postgres");
  await db.query("set local statement_timeout = '30s'");
  await db.query("set local lock_timeout = '5s'");
}

export async function captureProductionRows(db: DocumentBackfillDatabase, kind: BackfillKind, apply: boolean): Promise<Snapshot> {
  const snapshot: Snapshot = { project: PRODUCTION_PROJECT, kind, createdAt: new Date().toISOString(), rows: {}, objects: [] };
  const target = kind === "applicant" ? SNAPSHOT_TABLES[0] : kind === "cosigner" ? SNAPSHOT_TABLES[1] : kind === "calendar" ? SNAPSHOT_TABLES[2] : null;
  for (const table of SNAPSHOT_TABLES) {
    const size = await db.query(`select count(*)::text as rows, coalesce(sum(octet_length(row_to_json(t)::text)), 0)::text as bytes from public.${table} t`);
    if (size.rows.length !== 1 || !/^\d+$/.test(String(size.rows[0].rows)) || !/^\d+$/.test(String(size.rows[0].bytes)) ||
        Number(size.rows[0].rows) > MAX_ROWS_PER_TABLE || Number(size.rows[0].bytes) > MAX_SNAPSHOT_BYTES) {
      throw new Error("Security snapshot exceeds the fixed database limits.");
    }
    // Identifiers come only from this fixed list; limit before materializing any rows.
    const result = await db.query(`select * from public.${table} limit ${MAX_ROWS_PER_TABLE + 1}${apply && target === table ? " for update" : ""}`);
    if (result.rows.length > MAX_ROWS_PER_TABLE) throw new Error("Security snapshot row limit exceeded.");
    snapshot.rows[table] = result.rows;
    boundedSnapshotJson(snapshot);
  }
  return snapshot;
}

export async function inventoryProductionDocuments(snapshot: Snapshot, storage: SupabaseClient) {
  const bucket = storage.storage.from(APPLICATION_DOCUMENTS_BUCKET);
  let totalBytes = 0;
  for (const row of snapshot.rows.manager_application_records) {
    const applicationId = String(row.id);
    const folder = `application/${applicationPhotoFolderKey(applicationId)}`;
    const listed = await bucket.list(folder, { limit: 1000 });
    if (listed.error || !listed.data || listed.data.length >= 1000) throw new Error("Incomplete application document inventory.");
    for (const file of listed.data) {
      if (!file.id || !file.name || file.name.includes("/") || snapshot.objects.length >= MAX_DOCUMENT_OBJECTS) throw new Error("Unsupported document inventory.");
      const path = `${folder}/${file.name}`;
      const result = await bucket.download(path);
      if (result.error || !result.data || result.data.size > 15732736 || totalBytes + result.data.size > MAX_SNAPSHOT_BYTES / 2) {
        throw new Error("Document backup unavailable or exceeds fixed byte limits.");
      }
      const bytes = Buffer.from(await result.data.arrayBuffer());
      totalBytes += bytes.length;
      if (path.endsWith(".penc")) decryptApplicationDocumentBytes(bytes, path);
      snapshot.objects.push({ applicationId, path, bytes: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"), contentType: result.data.type || "application/octet-stream" });
      boundedSnapshotJson(snapshot);
    }
  }
}

/** A changed original must be inventoried/backed up again before replacement. */
export function storageWithBackedUpOriginals(storage: SupabaseClient, snapshot: Snapshot): SupabaseClient {
  const originals = new Map(snapshot.objects.filter((object) => !object.path.endsWith(".penc")).map((object) => [object.path, object.sha256]));
  const bucket = storage.storage.from(APPLICATION_DOCUMENTS_BUCKET);
  const guarded = new Proxy(bucket, { get(target, property) {
    if (property === "download") return async (path: string) => {
      const result = await target.download(path);
      if (!path.endsWith(".penc")) {
        const expected = originals.get(path);
        if (!expected || result.error || !result.data || result.data.size > 15732736 ||
            createHash("sha256").update(Buffer.from(await result.data.arrayBuffer())).digest("hex") !== expected) {
          throw new Error("Document source changed after verified backup.");
        }
      }
      return result;
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return new Proxy(storage, { get(target, property) {
    if (property === "storage") return { from: (name: string) => {
      if (name !== APPLICATION_DOCUMENTS_BUCKET) throw new Error("Unexpected storage bucket.");
      return guarded;
    } };
    return Reflect.get(target, property);
  } });
}

export async function transformProductionRows(db: DocumentBackfillDatabase, snapshot: Snapshot, apply: boolean) {
  const counts = { scannedRows: 0, changedRows: 0, plaintextFields: 0 };
  const { kind } = snapshot;
  const table = kind === "applicant" ? SNAPSHOT_TABLES[0] : kind === "cosigner" ? SNAPSHOT_TABLES[1] : SNAPSHOT_TABLES[2];
  if (kind === "calendar") {
    const columns = await db.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'manager_automation_settings'");
    if (!columns.rows.some((row) => row.column_name === "google_calendar" || row.column_name === "row_data")) throw new Error("Calendar storage unavailable.");
  }
  for (const row of snapshot.rows[table]) {
    counts.scannedRows++;
    if (kind !== "calendar") {
      const protect = kind === "applicant" ? protectApplicantRecord : protectCosignerRecord;
      const result = protect(row.row_data, String(row.id), row.manager_user_id == null ? null : String(row.manager_user_id));
      counts.plaintextFields += result.plaintextFields;
      if (!result.changed) continue;
      counts.changedRows++;
      if (apply) await db.query(`update public.${table} set row_data = $1::jsonb, updated_at = now() where id = $2`, [JSON.stringify(result.value), row.id]);
      continue;
    }
    const patches: Record<string, unknown> = {};
    if (Object.hasOwn(row, "google_calendar")) {
      const result = protectCalendarTokens(row.google_calendar, String(row.manager_user_id));
      counts.plaintextFields += result.plaintext;
      if (result.changed) patches.google_calendar = result.value;
    }
    if (row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)) {
      const data = row.row_data as Record<string, unknown>;
      const result = protectCalendarTokens(data.google_calendar, String(row.manager_user_id));
      counts.plaintextFields += result.plaintext;
      if (result.changed) patches.row_data = { ...data, google_calendar: result.value };
    }
    const keys = Object.keys(patches);
    if (!keys.length) continue;
    counts.changedRows++;
    if (apply) {
      const sets = keys.map((key, index) => `${key} = $${index + 1}::jsonb`);
      if (Object.hasOwn(row, "updated_at")) sets.push("updated_at = now()");
      await db.query(`update public.manager_automation_settings set ${sets.join(", ")} where manager_user_id = $${keys.length + 1}`,
        [...keys.map((key) => JSON.stringify(patches[key])), row.manager_user_id]);
    }
  }
  return counts;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseProductionBackfillArgs(args);
  assertProductionUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (options.kind === "document" && !key) throw new Error("Production storage service credentials required.");
  const storage = options.kind === "document" ? createClient(`https://${PRODUCTION_PROJECT}.supabase.co`, key!, {
    auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }),
    },
  }) : null;
  const db = await connectProductionDatabase(productionDatabaseConfig());
  try {
    await transaction(db, options.apply && options.kind !== "document");
    await verifyProductionMigrationHistory(db);
    const snapshot = await captureProductionRows(db, options.kind, options.apply);
    if (storage) {
      await db.query("rollback");
      await inventoryProductionDocuments(snapshot, storage);
    }
    const backup = options.apply ? writeProductionSnapshot(options.backupDirectory!, snapshot) : null;
    if (!storage) {
      const counts = await transformProductionRows(db, snapshot, options.apply);
      await db.query(options.apply ? "commit" : "rollback");
      return { mode: options.apply ? "apply" : "dry-run", ...counts, backup };
    }
    const guarded = storageWithBackedUpOriginals(storage, snapshot);
    const counts = { applications: snapshot.rows.manager_application_records.length, candidates: 0, migrated: 0, cleanupPending: 0, protectedObjects: 0, applicationDeleted: 0 };
    for (const object of snapshot.objects) {
      if (object.path.endsWith(".penc")) { counts.protectedObjects++; continue; }
      // Existing aliases can avoid a source download in the shared helper: verify first in that case too.
      const checked = await guarded.storage.from(APPLICATION_DOCUMENTS_BUCKET).download(object.path);
      if (checked.error || !checked.data) throw new Error("Backed-up original unavailable.");
      const result = await migrateApplicationDocumentObject(db, guarded, object.applicationId, object.path, options.apply);
      if (result === "candidate") counts.candidates++;
      if (result === "migrated") counts.migrated++;
      if (result === "cleanup-pending") counts.cleanupPending++;
      if (result === "application-deleted") counts.applicationDeleted++;
    }
    return { mode: options.apply ? "apply" : "dry-run", ...counts, backup };
  } catch {
    await db.query("rollback").catch(() => undefined);
    throw new Error("Production backfill stopped. Database changes roll back; document operations may be partially complete and are resumable. Inspect aggregate evidence and retry safely.");
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => {
    console.log(JSON.stringify(result));
    if ("cleanupPending" in result && (result.cleanupPending || result.applicationDeleted)) process.exitCode = 1;
  }).catch(() => {
    console.error("Production backfill failed. No credentials or customer content are logged. Verify the target, migration history, TLS, backup and key configuration before retrying.");
    process.exitCode = 1;
  });
}
