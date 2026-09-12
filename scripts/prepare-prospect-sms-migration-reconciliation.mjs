#!/usr/bin/env node
/**
 * Review the private pre-reconciliation Supabase ledgers and perform only the
 * two unambiguous historical-name repairs. DDL is deliberately outside this
 * runner: Supabase CLI must apply the small, reviewed pending batches first.
 *
 * The production bundles are evidence, not aliases. Their individual names
 * remain blocked on a fresh catalog attestation, so this script cannot turn a
 * bundle title, table name, or similar SQL into a migration identity.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET_PROJECT_REFS, validateTargetConnection } from "./check-migration-parity.mjs";

export const CAPTURED_LEDGER_SHA256 = Object.freeze({
  staging: "fbdc8f235d6846b592434092ad3b08751d2eeb6cb025c699845c4e99a6c99b93",
  production: "e64295431a7384a57f7423bba81376bc9319e9e36ca94f88e5d690ea507e5817",
});

export const LEDGER_RENAMES = Object.freeze({
  staging: Object.freeze([
    {
      version: "20260716090000",
      from: "agent_pending_actions",
      to: "agent_pending_actions_portal_columns",
      source: "20260716090000_agent_pending_actions_portal_columns.sql",
    },
    // This older, remote-only row must remain in history, but cannot retain the
    // same name as the later canonical resident_invite_links migration.
    {
      version: "20260907073044",
      from: "resident_invite_links",
      to: "resident_invite_links_legacy_20260907073044",
      source: null,
    },
  ]),
  production: Object.freeze([
    {
      version: "20260716090000",
      from: "agent_pending_actions",
      to: "agent_pending_actions_portal_columns",
      source: "20260716090000_agent_pending_actions_portal_columns.sql",
    },
  ]),
});

const CAPTURED_DUPLICATES = Object.freeze({
  staging: Object.freeze(["duplicate-name:agent_pending_actions", "duplicate-name:resident_invite_links"]),
  production: Object.freeze(["duplicate-name:agent_pending_actions"]),
});

export const PENDING_DDL = Object.freeze({
  staging: Object.freeze([
    "20260911190000_sms_conversation_houses",
    "20260911230000_portal_workspaces",
    "20260912000000_vendor_business_profiles",
    "20260912143000_prospect_sms_bursts",
    "20260912150000_shared_room_capacity_normalization_occupancy_start",
  ]),
  production: Object.freeze([
    "20260912143000_prospect_sms_bursts",
    "20260912150000_shared_room_capacity_normalization_occupancy_start",
  ]),
});

/**
 * Production's historical bundle rows stay unique and are retained. A mirror
 * row may only be added after the root's read-only catalog query proves its
 * final object contract. shared_room_capacity additionally requires the
 * occupancy_start correction in PENDING_DDL before that attestation.
 */
export const PRODUCTION_BUNDLE_LINEAGE = Object.freeze([
  ["20260802120000_portal_inbox_attachments_bucket", "20260907013451_portal_inbox_attachments_bucket_repair"],
  ["20260831140000_manager_sms_contact_email", "20260906214158_sms_contact_email_and_manager_sms_sessions_and_work_order_events"],
  ["20260902120000_manager_sms_agent_sessions", "20260906214158_sms_contact_email_and_manager_sms_sessions_and_work_order_events"],
  ["20260904130000_work_order_events", "20260906214158_sms_contact_email_and_manager_sms_sessions_and_work_order_events"],
  ["20260904133000_manager_assistant_emails_mailbox_local", "20260906211554_manager_assistant_emails"],
  ["20260904140000_action_event_bus", "20260906214225_action_event_bus_and_co_manager_explicit_grant_and_invite_expiry"],
  ["20260904150000_co_manager_permissions_explicit_grant", "20260906214225_action_event_bus_and_co_manager_explicit_grant_and_invite_expiry"],
  ["20260904160000_account_link_invites_expiry", "20260906214225_action_event_bus_and_co_manager_explicit_grant_and_invite_expiry"],
  ["20260904170000_work_order_vendor_offers_declined", "20260906214225_action_event_bus_and_co_manager_explicit_grant_and_invite_expiry"],
  ["20260904183000_reminder_queue_expand_kinds", "20260906214241_reminder_kinds_and_comms_billing_and_voice_sessions"],
  ["20260904194500_reminder_queue_payment_manager_kind", "20260906214241_reminder_kinds_and_comms_billing_and_voice_sessions"],
  ["20260905130000_manager_comms_billing", "20260906214241_reminder_kinds_and_comms_billing_and_voice_sessions"],
  ["20260905194500_manager_voice_agent_sessions", "20260906214241_reminder_kinds_and_comms_billing_and_voice_sessions"],
  ["20260905210000_manager_comms_usage_invoicing", "20260906214259_comms_invoicing_action_event_domains_and_open_invite_token"],
  ["20260905220000_comms_usage_work_number_setup", "20260906214259_comms_invoicing_action_event_domains_and_open_invite_token"],
  ["20260905230000_action_event_cross_party_domains", "20260906214259_comms_invoicing_action_event_domains_and_open_invite_token"],
  ["20260906010000_account_link_open_invite_token", "20260906214259_comms_invoicing_action_event_domains_and_open_invite_token"],
  ["20260906070000_shared_room_capacity", "20260906214429_shared_room_capacity_helpers + 20260906214510_shared_room_capacity_triggers"],
  ["20260906080000_sales_migration_provenance", "20260906214533_sales_provenance_utility_allocations_statement_match"],
  ["20260906081000_utility_allocations", "20260906214533_sales_provenance_utility_allocations_statement_match"],
  ["20260906085000_statement_match_targets", "20260906214533_sales_provenance_utility_allocations_statement_match"],
]);

const PRODUCTION_EVIDENCE_SHA256 = Object.freeze({
  ledger: "e64295431a7384a57f7423bba81376bc9319e9e36ca94f88e5d690ea507e5817",
  schema: "8ae45fcd16f3782e1897d20a3c1c8a5098f398f36bb9c587570d9649f4e07c6c",
  inboxBucket: "f102777850202483e57e08f8c24059edcc58334b922fc1d99b271576ec0b8635",
  storagePolicies: "a02d226c36da62e4dc8d68e623c97df47c39f5ad7ec648d1353b16a08a1c59c5",
});
const PRODUCTION_CATALOG_ATTESTATION_SHA256 = "269baaaaa584d1d49f2ba5e7e288b556ce11f65e9654994df17114e67d026036";
const PRODUCTION_CATALOG_ATTESTATION_FILE = "/tmp/prospect-sms-reconcile/production-catalog-attestation.json";
const SHARED_ROOM_CORRECTION_SHA256 = "78a25930905b34d16348f7f5d28023a184a89ae0bf5a08d2f673de0048484f28";

const BUNDLE_LINEAGE_NORMALIZERS = Object.freeze({
  // Production's bundle records the executable grant transformation exactly.
  // The only local-file tail not present there is the later descriptive COMMENT.
  "20260904150000_co_manager_permissions_explicit_grant": (sql) => sql.replace(/\ncomment on[\s\S]*$/i, ""),
});

const CATALOG_ATTESTED_LINEAGE = new Set([
  "20260904150000_co_manager_permissions_explicit_grant",
  "20260904183000_reminder_queue_expand_kinds",
  "20260904194500_reminder_queue_payment_manager_kind",
  "20260906070000_shared_room_capacity",
  "20260906080000_sales_migration_provenance",
  "20260906081000_utility_allocations",
  "20260906085000_statement_match_targets",
]);

const SOURCE_DIR = resolve(process.cwd(), "supabase", "migrations");
const REQUIRED_OCCUPANCY_CONTRACT = Object.freeze([
  "occupancy_start",
  "old_row.occupancy_start",
  "insert into public.manager_application_records",
]);
const OCCUPANCY_CATALOG_SQL = `select p.prosecdef,coalesce(p.proconfig,'{}'::text[]) as proconfig,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') as public_execute,
  has_function_privilege('anon',p.oid,'execute') as anon_execute,
  has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'execute') as service_execute,
  p.prosrc as body
  from pg_proc p where p.oid='public.normalize_application_record_id(text,jsonb,jsonb)'::regprocedure`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Strip line comments and normalize only lexical whitespace outside literals. */
export function normalizeSql(input) {
  let output = "";
  let index = 0;
  let whitespace = false;
  let quote = "";
  while (index < input.length) {
    const char = input[index];
    if (!quote && char === "-" && input[index + 1] === "-") {
      index = input.indexOf("\n", index + 2);
      if (index === -1) break;
      whitespace = true;
      continue;
    }
    if (!quote && (char === ";" || /\s/.test(char))) {
      whitespace = output.length > 0;
      index += 1;
      continue;
    }
    if (whitespace) {
      output += " ";
      whitespace = false;
    }
    output += char;
    if (!quote && (char === "'" || char === '"')) quote = char;
    else if (quote === char) {
      if (char === "'" && input[index + 1] === "'") {
        output += input[index + 1];
        index += 2;
        continue;
      }
      quote = "";
    }
    index += 1;
  }
  return output.trim();
}

function sourceSql(file) {
  return readFileSync(resolve(SOURCE_DIR, file), "utf8");
}

export function correctionFunctionBody({ readSource = sourceSql } = {}) {
  const source = readSource("20260912150000_shared_room_capacity_normalization_occupancy_start.sql");
  if (sha256(source) !== SHARED_ROOM_CORRECTION_SHA256) throw new Error("shared-room correction source changed");
  const match = /\bas \$\$\n?([\s\S]*?)\n?\$\$;/i.exec(source);
  if (!match) throw new Error("shared-room correction body is unavailable");
  return match[1];
}

function rowKey(row) {
  return `${row.version}\0${row.name}`;
}

export function identityProblems(rows) {
  const seenVersions = new Set();
  const seenNames = new Set();
  const problems = [];
  for (const row of rows) {
    if (!row || typeof row.version !== "string" || typeof row.name !== "string" || !Array.isArray(row.statements)) {
      problems.push("invalid-row");
      continue;
    }
    if (seenVersions.has(row.version)) problems.push(`duplicate-version:${row.version}`);
    if (seenNames.has(row.name)) problems.push(`duplicate-name:${row.name}`);
    seenVersions.add(row.version);
    seenNames.add(row.name);
  }
  return problems;
}

function findRow(rows, version, name) {
  return rows.find((row) => row.version === version && row.name === name);
}

export function inspectCapturedLedger(target, rows, { enforceCaptureFingerprint = false, rawCapture = "" } = {}) {
  if (!Object.hasOwn(TARGET_PROJECT_REFS, target) || !Array.isArray(rows)) throw new Error("invalid reconciliation target or ledger");
  if (enforceCaptureFingerprint && sha256(rawCapture) !== CAPTURED_LEDGER_SHA256[target]) throw new Error("captured ledger fingerprint changed");
  const problems = identityProblems(rows);
  const repairs = LEDGER_RENAMES[target].map((rename) => {
    const row = findRow(rows, rename.version, rename.from);
    if (!row) throw new Error(`expected old identity is absent: ${rename.version}`);
    if (rename.source && normalizeSql(row.statements.join(";\n")) !== normalizeSql(sourceSql(rename.source))) {
      throw new Error(`expected SQL differs: ${rename.version}`);
    }
    if (findRow(rows, rename.version, rename.to) || rows.some((entry) => entry.name === rename.to)) {
      throw new Error(`new identity is already occupied: ${rename.to}`);
    }
    return { ...rename, statements: row.statements };
  });
  if (JSON.stringify(problems.sort()) !== JSON.stringify(CAPTURED_DUPLICATES[target])) throw new Error("unexpected captured-ledger identities");
  return { target, repairs, pendingDdl: PENDING_DDL[target], bundledProductionLineage: target === "production" ? PRODUCTION_BUNDLE_LINEAGE : [] };
}

export function guardedRenameSql() {
  return "update supabase_migrations.schema_migrations set name=$1 where version=$2 and name=$3 and statements=$4 returning version,name";
}

export function guardedMirrorSql() {
  return "insert into supabase_migrations.schema_migrations(version,name,statements) select $1,$2,array[$3::text] where not exists (select 1 from supabase_migrations.schema_migrations where version=$1 or name=$2) returning version,name";
}

function parseIdentity(identity) {
  const match = /^(\d{14})_(.+)$/.exec(identity);
  if (!match) throw new Error(`invalid mirror identity: ${identity}`);
  return { version: match[1], name: match[2] };
}

function mirrorOperations(rows) {
  return PRODUCTION_BUNDLE_LINEAGE.map(([identity, bundle]) => {
    const source = parseIdentity(identity);
    if (findRow(rows, source.version, source.name)) throw new Error(`canonical mirror already present: ${identity}`);
    if (bundle) {
      const bundleIdentity = parseIdentity(bundle.split(" + ")[0]);
      const bundleRow = findRow(rows, bundleIdentity.version, bundleIdentity.name);
      if (!bundleRow) throw new Error(`bundle lineage missing: ${bundle}`);
      const normalizeLineage = BUNDLE_LINEAGE_NORMALIZERS[identity] ?? ((value) => value);
      if (!CATALOG_ATTESTED_LINEAGE.has(identity) || BUNDLE_LINEAGE_NORMALIZERS[identity]) {
        const lineageSql = normalizeLineage(sourceSql(`${identity}.sql`));
        if (!normalizeSql(bundleRow.statements.join(";\n")).includes(normalizeSql(lineageSql))) {
          throw new Error(`bundle lineage SQL differs: ${identity}`);
        }
      }
    }
    const sql = sourceSql(`${identity}.sql`);
    return { ...source, identity, bundle, sql, sourceSha256: sha256(sql) };
  });
}

function assertMirrorAttestation(attestation, operations) {
  assertPinnedProductionEvidence();
  let raw;
  try { raw = readFileSync(PRODUCTION_CATALOG_ATTESTATION_FILE); } catch { throw new Error("production catalog attestation is unavailable"); }
  if (sha256(raw) !== PRODUCTION_CATALOG_ATTESTATION_SHA256) throw new Error("production catalog attestation changed");
  const pinned = JSON.parse(raw.toString("utf8"));
  if (!attestation || JSON.stringify(attestation) !== JSON.stringify(pinned) || pinned.target !== "production" ||
      pinned.projectRef !== TARGET_PROJECT_REFS.production || !Array.isArray(pinned.evidence) || !Array.isArray(pinned.migrations)) {
    throw new Error("production catalog attestation refused");
  }
  const evidence = new Map(pinned.evidence.map((row) => [row.file, row.sha256]));
  if (evidence.get("production-ledger-before.json") !== CAPTURED_LEDGER_SHA256.production ||
      evidence.get("production-schema-before.sql") !== PRODUCTION_EVIDENCE_SHA256.schema ||
      evidence.get("production-inbox-bucket.json") !== PRODUCTION_EVIDENCE_SHA256.inboxBucket ||
      evidence.get("production-storage-policies.json") !== PRODUCTION_EVIDENCE_SHA256.storagePolicies ||
      evidence.size !== 4) throw new Error("production catalog evidence refused");
  const prerequisite = pinned.prerequisites?.[0];
  if (!prerequisite || pinned.prerequisites.length !== 1 || prerequisite.migrationVersion !== "20260912150000" ||
      prerequisite.migrationName !== "shared_room_capacity_normalization_occupancy_start" ||
      prerequisite.sourceSha256 !== SHARED_ROOM_CORRECTION_SHA256 ||
      prerequisite.functionSignature !== "public.normalize_application_record_id(text,jsonb,jsonb)" ||
      prerequisite.securityDefiner !== true || prerequisite.searchPath !== "" ||
      JSON.stringify(prerequisite.acl) !== JSON.stringify({ publicExecute: false, anonExecute: false, authenticatedExecute: false, serviceRoleExecute: true })) {
    throw new Error("shared-room correction attestation refused");
  }
  for (const operation of operations) {
    const migration = pinned.migrations.find((row) => row.version === operation.version && row.name === operation.name);
    if (!migration || migration.sourceFile !== `supabase/migrations/${operation.identity}.sql` || migration.sourceSha256 !== operation.sourceSha256 || !Array.isArray(migration.lineage)) {
      throw new Error(`production mirror attestation refused: ${operation.identity}`);
    }
  }
  return pinned;
}

function assertAttestedLineageInLedger(attestation, rows) {
  for (const migration of attestation.migrations) {
    for (const lineage of migration.lineage) {
      const row = findRow(rows, lineage.version, lineage.name);
      if (!row || sha256(JSON.stringify(row.statements)) !== lineage.statementsSha256) {
        throw new Error(`production lineage changed: ${migration.version}`);
      }
    }
  }
}

function assertPinnedProductionEvidence() {
  const evidence = [
    ["/tmp/prospect-sms-reconcile/production-ledger-before.json", PRODUCTION_EVIDENCE_SHA256.ledger],
    ["/tmp/prospect-sms-reconcile/production-schema-before.sql", PRODUCTION_EVIDENCE_SHA256.schema],
    ["/tmp/prospect-sms-reconcile/production-inbox-bucket.json", PRODUCTION_EVIDENCE_SHA256.inboxBucket],
    ["/tmp/prospect-sms-reconcile/production-storage-policies.json", PRODUCTION_EVIDENCE_SHA256.storagePolicies],
  ];
  for (const [file, expected] of evidence) {
    let bytes;
    try { bytes = readFileSync(file); } catch { throw new Error("pinned production evidence is unavailable"); }
    if (sha256(bytes) !== expected) throw new Error("pinned production evidence changed");
  }
}

export function productionMirrorAttestationTemplate(rows, { catalogSha256, sharedRoomOccupancyCatalogSha256 } = {}) {
  const operations = mirrorOperations(rows);
  return {
    target: "production",
    capturedLedgerSha256: CAPTURED_LEDGER_SHA256.production,
    inboxBucketSha256: PRODUCTION_EVIDENCE_SHA256.inboxBucket,
    storagePoliciesSha256: PRODUCTION_EVIDENCE_SHA256.storagePolicies,
    catalogSha256: catalogSha256 ?? "",
    sharedRoomOccupancyCatalogSha256: sharedRoomOccupancyCatalogSha256 ?? "",
    sharedRoomOccupancyCorrected: false,
    mirrors: operations.map(({ identity, bundle, sourceSha256 }) => ({ identity, bundle, sourceSha256 })),
  };
}

export function occupancyContractIsPresent(functionDefinition) {
  const normalized = normalizeSql(functionDefinition).toLowerCase();
  return REQUIRED_OCCUPANCY_CONTRACT.every((fragment) => normalized.includes(fragment)) &&
    normalizeSql(functionDefinition) === normalizeSql(correctionFunctionBody());
}

async function assertLiveOccupancyContract(client) {
  const row = (await client.query(OCCUPANCY_CATALOG_SQL)).rows[0];
  const config = Array.isArray(row?.proconfig) ? row.proconfig : [];
  if (!row?.prosecdef || row.public_execute || row.anon_execute || row.authenticated_execute || !row.service_execute ||
      !config.some((value) => String(value).toLowerCase() === "search_path=\"\"" || String(value).toLowerCase() === "search_path=") ||
      !occupancyContractIsPresent(row.body)) throw new Error("shared-room occupancy catalog refused");
}

async function readLedger(client) {
  const result = await client.query("select version,name,statements from supabase_migrations.schema_migrations order by version,name");
  return result.rows;
}

function sameLedger(left, right) {
  return JSON.stringify([...left].sort((a, b) => rowKey(a).localeCompare(rowKey(b)))) ===
    JSON.stringify([...right].sort((a, b) => rowKey(a).localeCompare(rowKey(b))));
}

export function assertOnlyReviewedDdlWasAdded(target, baseline, current) {
  const baselineKeys = new Set(baseline.map(rowKey));
  const additions = current.filter((row) => !baselineKeys.has(rowKey(row)));
  const expected = new Set(PENDING_DDL[target]);
  if (additions.length !== expected.size) throw new Error("unexpected post-baseline ledger additions");
  for (const row of additions) {
    const identity = `${row.version}_${row.name}`;
    if (!expected.delete(identity) || normalizeSql(row.statements.join(";\n")) !== normalizeSql(sourceSql(`${identity}.sql`))) {
      throw new Error(`unexpected post-baseline ledger identity: ${identity}`);
    }
  }
  if (expected.size) throw new Error("reviewed DDL is missing from current ledger");
}

/** Injectable for isolated tests. The CLI is the only production caller. */
export async function executeGuardedLedgerRenames({ target, dbUrl, expectedLedger, catalogAttestation, createClient }) {
  const binding = validateTargetConnection(target, dbUrl);
  if (!binding.ok) throw new Error("target binding refused");
  const plan = inspectCapturedLedger(target, expectedLedger);
  const mirrors = target === "production" ? mirrorOperations(expectedLedger) : [];
  const pinnedAttestation = mirrors.length ? assertMirrorAttestation(catalogAttestation, mirrors) : null;
  const client = createClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000, statement_timeout: 15_000 });
  let began = false;
  try {
    await client.connect();
    await client.query("BEGIN"); began = true;
    await client.query("lock table supabase_migrations.schema_migrations in share row exclusive mode");
    const current = await readLedger(client);
    if (!sameLedger(current, expectedLedger)) throw new Error("ledger drift refused");
    if (pinnedAttestation) {
      assertAttestedLineageInLedger(pinnedAttestation, current);
      await assertLiveOccupancyContract(client);
    }
    for (const repair of plan.repairs) {
      const result = await client.query(guardedRenameSql(), [repair.to, repair.version, repair.from, repair.statements]);
      if (result.rowCount !== 1) throw new Error(`identity repair refused: ${repair.version}`);
    }
    for (const mirror of mirrors) {
      const result = await client.query(guardedMirrorSql(), [mirror.version, mirror.name, mirror.sql]);
      if (result.rowCount !== 1) throw new Error(`canonical mirror refused: ${mirror.identity}`);
    }
    const repaired = await readLedger(client);
    if (identityProblems(repaired).length !== 0) throw new Error("duplicate identities remain after repair");
    await client.query("COMMIT"); began = false;
    return { outcome: "reconciled", target, renamed: plan.repairs.map(({ version, to }) => ({ version, name: to })), mirrored: mirrors.map(({ identity }) => identity) };
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function parseArgs(argv) {
  const values = { target: "", ledger: "", baselineLedger: "", dbUrl: "", catalogAttestation: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") { if (values.apply) throw new Error("invalid arguments"); values.apply = true; continue; }
    const key = token === "--db-url" ? "dbUrl" : token === "--catalog-attestation" ? "catalogAttestation" : token === "--baseline-ledger" ? "baselineLedger" : token.replace(/^--/, "");
    if (!Object.hasOwn(values, key) || !["target", "ledger", "baselineLedger", "dbUrl", "catalogAttestation"].includes(key) || values[key]) throw new Error("invalid arguments");
    values[key] = argv[++index] ?? "";
    if (!values[key]) throw new Error("invalid arguments");
  }
  if (!values.target || !values.ledger || (values.apply && (!values.dbUrl || !values.baselineLedger || (values.target === "production" && !values.catalogAttestation)))) throw new Error("invalid arguments");
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawCapture = readFileSync(args.ledger, "utf8");
  const ledger = JSON.parse(rawCapture);
  const plan = inspectCapturedLedger(args.target, ledger);
  if (!args.apply) {
    console.log(JSON.stringify({ target: plan.target, pendingDdl: plan.pendingDdl, ledgerRenames: plan.repairs.map(({ version, from, to }) => ({ version, from, to })), bundledProductionLineage: plan.bundledProductionLineage, sharedRoomCatalogRequirement: "normalize_application_record_id must preserve occupancy_start after 20260912150000" }));
    return;
  }
  const rawBaseline = readFileSync(args.baselineLedger, "utf8");
  const baseline = JSON.parse(rawBaseline);
  inspectCapturedLedger(args.target, baseline, { enforceCaptureFingerprint: true, rawCapture: rawBaseline });
  for (const row of baseline) {
    const current = findRow(ledger, row.version, row.name);
    if (!current || JSON.stringify(current.statements) !== JSON.stringify(row.statements)) throw new Error("captured baseline no longer matches current ledger");
  }
  assertOnlyReviewedDdlWasAdded(args.target, baseline, ledger);
  const { Client } = await import("pg");
  const catalogAttestation = args.catalogAttestation ? JSON.parse(readFileSync(args.catalogAttestation, "utf8")) : undefined;
  const result = await executeGuardedLedgerRenames({ target: args.target, dbUrl: args.dbUrl, expectedLedger: ledger, catalogAttestation, createClient: (options) => new Client(options) });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "migration reconciliation refused"); process.exitCode = 1; });
}
