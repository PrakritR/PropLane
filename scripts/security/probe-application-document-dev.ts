import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { nonproductionDatabaseConfig, connectNonproductionDatabase } from "./nonproduction-database.mjs";
import { migrateApplicationDocumentObject } from "./application-document-backfill";
import { decryptApplicationDocumentBytes } from "../../src/lib/security/application-document-crypto.server";
import { resolveApplicationDocumentStoragePath } from "../../src/lib/security/application-document-aliases.server";
import { APPLICATION_DOCUMENTS_BUCKET } from "../../src/lib/rental-application/application-photos";

const DEV_REF = "emstjswhotsnyksqhqyf";
const TEST_MANAGER_EMAIL = "manager@test.proplane.local";
const evidenceUrl = new URL("../../docs/security/2026-09-05-application-document-dev-probe.json", import.meta.url);

async function main() {
  if (process.argv.slice(2).join(" ") !== "--apply") throw new Error("Explicit --apply is required for this synthetic development probe.");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  if (url !== `https://${DEV_REF}.supabase.co`) throw new Error("Only the canonical development project is permitted.");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!serviceKey || !anonKey || !process.env.DATA_ENCRYPTION_KEYS_JSON || !process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID) {
    throw new Error("Development service/anonymous credentials and application keys are required.");
  }
  process.env.SUPABASE_DB_SSL_CA = readFileSync(new URL("./supabase-prod-ca-2021.crt", import.meta.url), "utf8");
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }),
  } };
  const service = createClient(url, serviceKey, clientOptions);
  const anonymous = createClient(url, anonKey, clientOptions);
  const db = await connectNonproductionDatabase(nonproductionDatabaseConfig(DEV_REF));
  const nonce = randomUUID();
  const applicationId = `PROPLANE-SECURITY-DOC-${nonce.toUpperCase()}`;
  const folder = `application/${applicationId}`;
  const sourcePath = `${folder}/income-probe.pdf`;
  const bytes = Buffer.from("%PDF-1.4\n% PropLane synthetic security probe; contains no customer data.\n%%EOF\n");
  let createdUserId: string | null = null;
  let applicationCreated = false;
  let applicationInsertAttempted = false;
  let primaryFailure = false;
  const evidence = {
    devOnly: true, tlsVerified: true, reusedTestManager: false, createdSyntheticUser: false,
    syntheticApplications: 0, syntheticOriginalObjects: 0, migrationSucceeded: false,
    ciphertextRoundtrip: false, noPlaintextInCiphertext: false, stableOriginalReference: false,
    originalRemoved: false, immediateOriginalDownloadDenied: false,
    authoritativeOriginalMetadataAbsent: false, cacheBustedOriginalDownloadDenied: false,
    anonymousAliasReadDenied: false,
    objectCleanupConfirmed: false, applicationCleanupConfirmed: false, createdUserCleanupConfirmed: true,
  };
  async function begin(readOnly = false) {
    await db.query(readOnly ? "begin read only" : "begin");
    await db.query("set local role postgres");
    await db.query("set local statement_timeout = '15s'");
    await db.query("set local lock_timeout = '5s'");
  }
  try {
    await begin(true);
    const managers = await db.query("select id from public.profiles where lower(email) = $1 and role = 'manager' limit 2", [TEST_MANAGER_EMAIL]);
    await db.query("commit");
    if (managers.rows.length > 1) throw new Error("Ambiguous synthetic test fixture.");
    let managerId = managers.rows[0]?.id as string | undefined;
    if (managerId) {
      evidence.reusedTestManager = true;
    } else {
      const result = await service.auth.admin.createUser({
        email: `security-document-${nonce}@test.proplane.local`,
        password: randomBytes(32).toString("base64url"), email_confirm: true,
        user_metadata: { role: "manager", security_probe: true },
      });
      if (result.error || !result.data.user?.id) throw new Error("Could not create isolated synthetic fixture.");
      createdUserId = result.data.user.id;
      managerId = createdUserId;
      evidence.createdSyntheticUser = true;
      evidence.createdUserCleanupConfirmed = false;
    }
    await begin();
    applicationInsertAttempted = true;
    await db.query("insert into public.manager_application_records (id, manager_user_id, row_data) values ($1, $2, $3::jsonb)", [applicationId, managerId, JSON.stringify({
      id: applicationId, managerUserId: managerId, bucket: "pending", securityProbe: nonce,
      application: { incomeProofPhotos: [{ storagePath: sourcePath, fileName: "synthetic.pdf", mimeType: "application/pdf", sizeBytes: bytes.length }] },
    })]);
    await db.query("commit");
    applicationCreated = true;
    evidence.syntheticApplications = 1;
    const bucket = service.storage.from(APPLICATION_DOCUMENTS_BUCKET);
    const uploaded = await bucket.upload(sourcePath, bytes, { contentType: "application/pdf", upsert: false });
    if (uploaded.error) throw new Error("Could not create synthetic original.");
    evidence.syntheticOriginalObjects = 1;
    const migrated = await migrateApplicationDocumentObject(db, service, applicationId, sourcePath, true);
    if (migrated !== "migrated") throw new Error("Synthetic migration did not finish.");
    evidence.migrationSucceeded = true;
    const resolvedPath = await resolveApplicationDocumentStoragePath(service, applicationId, sourcePath);
    const encrypted = await bucket.download(resolvedPath);
    if (encrypted.error || !encrypted.data) throw new Error("Synthetic replacement unavailable.");
    const ciphertext = Buffer.from(await encrypted.data.arrayBuffer());
    evidence.ciphertextRoundtrip = decryptApplicationDocumentBytes(ciphertext, resolvedPath).equals(bytes);
    evidence.noPlaintextInCiphertext = !ciphertext.includes(bytes);
    const row = await service.from("manager_application_records").select("row_data").eq("id", applicationId).single();
    evidence.stableOriginalReference = !row.error && row.data?.row_data?.application?.incomeProofPhotos?.[0]?.storagePath === sourcePath && resolvedPath !== sourcePath;
    const original = await bucket.download(sourcePath);
    evidence.immediateOriginalDownloadDenied = Boolean(original.error && !original.data);
    await begin(true);
    const remainingOriginal = await db.query("select count(*)::int as count from storage.objects where bucket_id = $1 and name = $2", [APPLICATION_DOCUMENTS_BUCKET, sourcePath]);
    evidence.authoritativeOriginalMetadataAbsent = remainingOriginal.rows[0]?.count === 0;
    await db.query("rollback");
    // Distinguish an actually retained origin object from a stale CDN response.
    // Only this synthetic path is requested; URL/keys/body never enter evidence.
    const fresh = await fetch(`${url}/storage/v1/object/authenticated/${APPLICATION_DOCUMENTS_BUCKET}/${sourcePath}?cacheNonce=${randomUUID()}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: "no-store", signal: AbortSignal.timeout(30000),
    });
    const missing = await fresh.json().catch(() => null) as { statusCode?: string | number } | null;
    evidence.cacheBustedOriginalDownloadDenied = fresh.status === 404 ||
      (fresh.status === 400 && String(missing?.statusCode) === "404");
    evidence.originalRemoved = evidence.authoritativeOriginalMetadataAbsent && evidence.cacheBustedOriginalDownloadDenied;
    const denied = await anonymous.from("application_document_storage_aliases").select("source_path").eq("source_path", sourcePath);
    evidence.anonymousAliasReadDenied = Boolean(denied.error && [401, 403].includes(denied.status));
    if (![evidence.ciphertextRoundtrip, evidence.noPlaintextInCiphertext, evidence.stableOriginalReference,
      evidence.originalRemoved, evidence.anonymousAliasReadDenied].every(Boolean)) throw new Error("Synthetic verification failed.");
  } catch {
    primaryFailure = true;
    await db.query("rollback").catch(() => undefined);
  } finally {
    try {
      // A COMMIT reply can be lost after the insert became durable. Re-derive
      // ownership from our random marker before cleanup, never from a broad seed.
      if (applicationInsertAttempted && !applicationCreated) {
        await begin(true);
        const owned = await db.query("select id from public.manager_application_records where id = $1 and row_data->>'securityProbe' = $2", [applicationId, nonce]);
        applicationCreated = owned.rows.length === 1;
        await db.query("rollback");
      }
      if (applicationCreated) {
        const bucket = service.storage.from(APPLICATION_DOCUMENTS_BUCKET);
        const listed = await bucket.list(folder, { limit: 100 });
        if (listed.error || !listed.data || listed.data.length >= 100 || listed.data.some((file) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.name))) {
          throw new Error("Probe object cleanup could not be bounded.");
        }
        const paths = listed.data.map((file) => `${folder}/${file.name}`);
        if (paths.length && (await bucket.remove(paths)).error) throw new Error("Probe object cleanup failed.");
        const remaining = await bucket.list(folder, { limit: 1 });
        evidence.objectCleanupConfirmed = !remaining.error && remaining.data?.length === 0;
        if (!evidence.objectCleanupConfirmed) throw new Error("Probe object cleanup unverified.");
        await begin();
        await db.query("delete from public.manager_application_records where id = $1 and row_data->>'securityProbe' = $2", [applicationId, nonce]);
        const remainingRows = await db.query("select id from public.manager_application_records where id = $1", [applicationId]);
        const remainingAliases = await db.query("select source_path from public.application_document_storage_aliases where application_id = $1", [applicationId]);
        evidence.applicationCleanupConfirmed = remainingRows.rows.length === 0 && remainingAliases.rows.length === 0;
        await db.query("commit");
      }
      if (createdUserId && (!applicationCreated || evidence.applicationCleanupConfirmed)) {
        const removed = await service.auth.admin.deleteUser(createdUserId);
        evidence.createdUserCleanupConfirmed = !removed.error;
      }
    } catch {
      primaryFailure = true;
      await db.query("rollback").catch(() => undefined);
    }
    await db.end();
    writeFileSync(evidenceUrl, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence));
  }
  if (primaryFailure || !evidence.objectCleanupConfirmed || !evidence.applicationCleanupConfirmed || !evidence.createdUserCleanupConfirmed) {
    throw new Error("Synthetic probe failed or cleanup is incomplete; inspect the aggregate evidence before retrying.");
  }
}

main().catch(() => {
  console.error("Development-only synthetic document probe failed. No credentials or document contents are logged.");
  process.exitCode = 1;
});
