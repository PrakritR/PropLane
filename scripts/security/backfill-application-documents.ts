import { createClient } from "@supabase/supabase-js";
import { applicationPhotoFolderKey } from "../../src/lib/rental-application/application-photos.server";
import { APPLICATION_DOCUMENTS_BUCKET } from "../../src/lib/rental-application/application-photos";
import { migrateApplicationDocumentObject } from "./application-document-backfill";
import { decryptApplicationDocumentBytes } from "../../src/lib/security/application-document-crypto.server";
import { NONPRODUCTION_PROJECTS, connectNonproductionDatabase, nonproductionDatabaseConfig } from "./nonproduction-database.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply") || args.length > 1) throw new Error("Use no args for dry run, or --apply for dev/staging.");
  const apply = args.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const ref = new URL(url).hostname.split(".")[0];
  if (url.replace(/\/$/, "") !== `https://${ref}.supabase.co` || !NONPRODUCTION_PROJECTS.includes(ref)) {
    throw new Error("A development or staging project is required.");
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Service credentials are required.");
  const storage = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }),
  } });
  const db = await connectNonproductionDatabase(nonproductionDatabaseConfig(ref));
  const counts = { mode: apply ? "apply" : "dry-run", applications: 0, candidates: 0, migrated: 0, cleanupPending: 0, protectedObjects: 0 };
  try {
    await db.query("begin read only");
    let rows;
    try {
      await db.query("set local role postgres");
      await db.query("set local statement_timeout = '30s'");
      rows = await db.query("select id from public.manager_application_records order by id");
      await db.query("commit");
    } catch {
      await db.query("rollback").catch(() => undefined);
      throw new Error("Application inventory unavailable.");
    }
    for (const row of rows.rows) {
      const applicationId = String(row.id);
      counts.applications++;
      const folder = `application/${applicationPhotoFolderKey(applicationId)}`;
      const listed = await storage.storage.from(APPLICATION_DOCUMENTS_BUCKET).list(folder, { limit: 1000 });
      if (listed.error || !listed.data || listed.data.length >= 1000) throw new Error("Document inventory unavailable or incomplete.");
      for (const file of listed.data) {
        if (!file.id) throw new Error("Unexpected nested document folder.");
        if (file.name.endsWith(".penc")) {
          const objectPath = `${folder}/${file.name}`;
          const encrypted = await storage.storage.from(APPLICATION_DOCUMENTS_BUCKET).download(objectPath);
          if (encrypted.error || !encrypted.data) throw new Error("Protected document unavailable.");
          decryptApplicationDocumentBytes(Buffer.from(await encrypted.data.arrayBuffer()), objectPath);
          counts.protectedObjects++;
          continue;
        }
        const result = await migrateApplicationDocumentObject(db, storage, applicationId, `${folder}/${file.name}`, apply);
        if (result === "candidate") counts.candidates++;
        if (result === "migrated") counts.migrated++;
        if (result === "cleanup-pending") counts.cleanupPending++;
      }
    }
    // Counts only: no application IDs, object paths, document text, URLs, or keys.
    console.log(JSON.stringify(counts));
    if (counts.cleanupPending) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch(() => {
  console.error("Application document backfill failed. Originals are retained until verified replacements and aliases commit; retry after correcting the configuration.");
  process.exitCode = 1;
});
