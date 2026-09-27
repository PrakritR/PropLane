#!/usr/bin/env node
/**
 * Bounded, resumable SMS projection reconciliation. Dry-run is the default.
 * Apply only against the dev/test project with --apply and a local --cursor-file.
 * Cursor files contain source IDs/timestamps and counters, never message bodies
 * or phone numbers. Unresolved source records remain in their original tables.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresInstantMicros, samePostgresInstant } from "../src/lib/sms/postgres-instant.mjs";

const DEV_PROJECT_REF = "emstjswhotsnyksqhqyf";
const NOTICE_SCOPE = "axis_portal_inbox_manager_v1";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const MAX_ORIGINAL_RPC_CONCURRENCY = 8;
const workLineRowsCache = new Map();

export function parseArgs(argv) {
  const args = { apply: false, batchSize: DEFAULT_BATCH_SIZE, maxPages: DEFAULT_MAX_PAGES, cursorFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (arg === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (arg === "--cursor-file") args.cursorFile = argv[++i];
    else if (arg === "--help") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 500) throw new Error("--batch-size must be 1..500");
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > 100) throw new Error("--max-pages must be 1..100");
  if (args.apply && !args.cursorFile) throw new Error("--apply requires --cursor-file for resumable progress");
  return args;
}

export function normalizeSmsPhone(value) {
  const text = String(value ?? "").trim();
  const digits = text.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export function buildSmsIdentity({ role, userId, phone, sourceId }) {
  const accountId = String(userId ?? "").trim();
  if (accountId) return { identityKind: "user", identityKey: `user:${accountId}` };
  const normalized = normalizeSmsPhone(phone);
  if (role !== "unknown" && normalized) return { identityKind: "phone", identityKey: `phone:${normalized}` };
  return { identityKind: "unresolved", identityKey: `unresolved:${String(sourceId ?? "missing-source")}` };
}

export function isExplicitNoticeOriginal(message) {
  return Boolean(message && typeof message === "object"
    && (message.sourceType === "provider_sms" || message.smsOriginal === true)
    && String(message.providerSid ?? message.messageSid ?? "").trim()
    && typeof message.body === "string"
    && postgresInstantMicros(message.at ?? message.occurredAt) !== null
    && (message.direction === "inbound" || message.direction === "outbound"));
}

export function isProjectionNoticeMarker(marker) {
  return Boolean(marker && typeof marker === "object" &&
    ["sourceNamespace", "sourceEventId", "ownerManagerUserId", "counterpartyRole", "workLineId", "occurredAt", "bodySha256"]
      .every((key) => typeof marker[key] === "string" && marker[key].trim()) &&
    postgresInstantMicros(marker.occurredAt) !== null && /^[a-f0-9]{64}$/i.test(marker.bodySha256));
}

export function shouldBindLegacyThreadAlias({ markedCount, projectionMarkerCount, messages, allMarkersBound, conversationIds }) {
  return markedCount > 0
    && markedCount === projectionMarkerCount
    && messages.every((message) => isProjectionNoticeMarker(message?.originalSmsEvent))
    && allMarkersBound
    && new Set(conversationIds).size === 1;
}

export function splitSourceIdentity(row, kind) {
  const sourceRowId = String(row?.id ?? (kind === "prospect_sms_ingress" ? row?.source_message_id : "") ?? "").trim();
  const sourceEventId = String(row?.message_sid ?? row?.twilio_sid ?? row?.source_message_id ?? "").trim();
  const isVoiceAnnotation = kind === "manager_sms_messages" && sourceEventId.startsWith("voice:");
  return {
    sourceRowId,
    providerEventId: sourceEventId && !isVoiceAnnotation ? sourceEventId : "",
    annotationEventId: isVoiceAnnotation ? sourceEventId : "",
  };
}

export function feedMayRunAfter(previousResults) {
  return previousResults.every((result) => !result.hasMore);
}

export function isCleanCutoverInventory(results) {
  return results.length > 0 && results.every((result) => !result.hasMore
    && result.counts.unresolvedLine === 0
    && result.counts.unresolvedNotice === 0
    && result.counts.unresolvedRelay === 0
    && result.counts.integrityMismatch === 0
    && result.counts.errors === 0
    && (result.counts.unboundOriginalMarkers ?? 0) === 0
    && (result.counts.malformedOriginalMarkers ?? 0) === 0);
}

function emptyCounts() {
  return {
    scanned: 0, projectable: 0, projected: 0, alreadyMapped: 0,
    unresolvedLine: 0, unresolvedNotice: 0, unresolvedRelay: 0, historicalOnly: 0,
    sourcePreferred: 0, integrityMismatch: 0, historicalImported: 0,
    enrichedPlaceholder: 0, derivedMirror: 0,
    deferredToTransport: 0, explicitNoticeMarkers: 0, errors: 0, owners: {},
  };
}

function addOwnerCount(counts, owner, key, amount = 1) {
  const id = String(owner ?? "unassigned");
  counts.owners[id] ??= {};
  counts.owners[id][key] = (counts.owners[id][key] ?? 0) + amount;
}

function cursorAfter(row, timestampColumn, idColumn) {
  return { at: String(row[timestampColumn]), id: String(row[idColumn]) };
}

function applyCursor(query, cursor, timestampColumn, idColumn) {
  if (!cursor) return query;
  return query.or(`${timestampColumn}.gt.${cursor.at},and(${timestampColumn}.eq.${cursor.at},${idColumn}.gt.${cursor.id})`);
}

async function resolveInboundOriginal(db, sid, owner) {
  const { data, error } = await db.rpc("resolve_sms_completed_receipt_original", {
    p_sid: sid, p_expected_owner: owner,
  });
  if (error || data?.ok !== true || data.sid !== sid || data.owner !== owner ||
      typeof data.body !== "string" || postgresInstantMicros(data.occurredAt) === null) {
    throw new Error(`inbound_original_${String(data?.reason ?? "lookup_failed")}`);
  }
  return data;
}

async function resolveRetainedHistoricalSource(db, table, sourceId) {
  const { data, error } = await db.rpc("resolve_sms_retained_historical_source", {
    p_source_table: table, p_source_id: String(sourceId),
  });
  if (error || !data || typeof data !== "object") throw new Error("retained_source_lookup_failed");
  if (data.eligible !== true) return null;
  if (data.sourceTable !== "inbound_sms_log" || !data.sourceId || !data.mirrorId || !data.owner ||
      !/^[a-f0-9]{64}$/.test(String(data.fingerprint)) || typeof data.body !== "string" ||
      postgresInstantMicros(data.occurredAt) === null || postgresInstantMicros(data.mirrorAt) === null) {
    throw new Error("retained_source_result_invalid");
  }
  return data;
}

function retainedHistoricalCandidate(source, feedTable, row) {
  if (String(row.id) !== String(feedTable === "inbound_sms_log" ? source.sourceId : source.mirrorId) ||
      String(row.manager_user_id) !== String(source.owner) || String(row.message_sid) !== String(source.sid)) {
    throw new Error("retained_source_row_mismatch");
  }
  const lineHash = createHash("md5").update(`retained:inbound_sms_log:${source.owner}:${source.sourceId}`).digest("hex");
  const lineId = `${lineHash.slice(0, 8)}-${lineHash.slice(8, 12)}-${lineHash.slice(12, 16)}-${lineHash.slice(16, 20)}-${lineHash.slice(20, 32)}`;
  const event = {
    ownerManagerUserId: source.owner, counterpartyRole: source.role,
    workLineId: lineId, identityKind: "unresolved", identityKey: `unresolved:inbound_sms_log:${source.sourceId}`,
    counterpartyUserId: null, counterpartyPhone: null, sourceNamespace: "retained:inbound_sms_log",
    sourceEventId: source.sourceId, direction: "inbound", body: source.body,
    occurredAt: source.occurredAt, fromPhone: source.fromPhone, toPhone: source.toPhone,
    sourceRef: { table: "inbound_sms_log", id: source.sourceId, historical: true,
      archiveReason: "receipt_owner_conflict", fingerprint: source.fingerprint },
  };
  return { owner: source.owner, event, line: null, sourceTable: feedTable,
    sourceId: String(row.id), sourceRowId: String(row.id), providerLookupId: source.sid,
    retainedHistorical: { sourceId: source.sourceId, mirrorId: source.mirrorId,
      fingerprint: source.fingerprint, isMirror: feedTable === "manager_sms_messages" } };
}

export async function mapBounded(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function keyOf(owner, namespace, sourceId) {
  return `${owner}\0${namespace}\0${sourceId}`;
}

export function eventMatchesStored(existing, event, {
  historicalLine = false, allowIdentityEnrichment = false, allowRoleEnrichment = false,
  allowMirrorTimeDrift = false,
} = {}) {
  const previousSource = existing.source_ref && typeof existing.source_ref === "object" ? existing.source_ref : {};
  const candidateSource = event.sourceRef && typeof event.sourceRef === "object" ? event.sourceRef : {};
  const sourceCompatible = previousSource.providerEventId && candidateSource.providerEventId
    ? previousSource.providerEventId === candidateSource.providerEventId
    : previousSource.table === candidateSource.table
      ? String(previousSource.id ?? "") === String(candidateSource.id ?? "")
      : true;
  const identityMatches = String(existing.identity_kind ?? "") === String(event.identityKind ?? "")
    && String(existing.identity_key ?? "") === String(event.identityKey ?? "")
    && String(existing.counterparty_user_id ?? "") === String(event.counterpartyUserId ?? "");
  const provenEnrichment = allowIdentityEnrichment
    && event.identityKind === "user"
    && Boolean(event.counterpartyUserId)
    && event.identityKey === `user:${event.counterpartyUserId}`
    && (existing.identity_kind === "unresolved"
      || (existing.identity_kind === "phone"
        && normalizeSmsPhone(existing.counterparty_phone) === normalizeSmsPhone(event.counterpartyPhone)));
  return existing.body === event.body
    && existing.direction === event.direction
    && (allowMirrorTimeDrift || samePostgresInstant(existing.occurred_at, event.occurredAt))
    && existing.from_phone === (event.fromPhone ?? null)
    && existing.to_phone === (event.toPhone ?? null)
    && String(existing.owner_manager_user_id) === String(event.ownerManagerUserId)
    && (String(existing.counterparty_role) === String(event.counterpartyRole)
      || (allowRoleEnrichment && existing.counterparty_role === "unknown" && event.counterpartyRole !== "unknown"))
    && (historicalLine || String(existing.work_line_id) === String(event.workLineId))
    && (identityMatches || provenEnrichment)
    && sourceCompatible;
}

export function isExactInboundMirrorOfOriginal(existing, event, candidate, { historicalLine = false } = {}) {
  const providerSid = existing.source_ref?.providerEventId;
  return candidate.sourceTable === "manager_sms_messages"
    && event.direction === "inbound"
    && (existing.source_ref?.table === "inbound_sms_log"
      || (existing.source_ref?.table === "prospect_sms_ingress" && candidate.sourceSubtype === "automated"))
    && typeof providerSid === "string" && /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(providerSid)
    && providerSid === candidate.providerLookupId
    && providerSid === event.sourceRef?.providerEventId
    && eventMatchesStored(existing, event, { historicalLine, allowMirrorTimeDrift: true });
}

export function retainedHistoricalUnplacedIdentity(existing, event, candidate) {
  return !candidate.line && existing.source_ref?.historical === true
    && existing.source_ref?.table === candidate.sourceTable
    && String(existing.source_ref?.id ?? "") === String(candidate.sourceRowId ?? "")
    && existing.metadata?.historical === true && existing.metadata?.sendDisabled === true
    && Number(existing.event_count) === 1
    && existing.identity_kind === "unresolved"
    && (existing.counterparty_user_id == null || String(existing.counterparty_user_id) === String(event.counterpartyUserId))
    && existing.counterparty_role === event.counterpartyRole
    && event.identityKind === "user" && event.identityKey === `user:${event.counterpartyUserId}`
    && eventMatchesStored(existing, event, { historicalLine: true, allowIdentityEnrichment: true });
}

export function sourceNamespace(owner, providerEventId, sourceTable) {
  if (sourceTable === "manager_sms_messages" && String(providerEventId ?? "").startsWith("voice:")) {
    return `voice:${owner}`;
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || "unconfigured";
  return `twilio:${owner}:${accountSid}`;
}

async function loadWorkLine(db, owner, workPhone, occurredAt) {
  const raw = String(workPhone ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeSmsPhone(raw);
  const variants = [...new Set([raw, normalized].filter(Boolean))];
  const cacheKey = `${owner}\0${normalized || raw}`;
  let data = workLineRowsCache.get(cacheKey);
  if (!data) {
    const result = await db.from("manager_sms_numbers")
      .select("id,manager_user_id,workspace_id,phone_number,provision_state,requested_at,provisioned_at,released_at")
      .in("phone_number", variants)
      .in("provision_state", ["active", "released"]);
    if (result.error || !result.data) throw new Error("work_line_lookup_failed");
    data = result.data;
    workLineRowsCache.set(cacheKey, data);
  }
  const instant = postgresInstantMicros(occurredAt);
  if (instant === null) return null;
  const workspaceIds = [...new Set(data.map((row) => String(row.workspace_id ?? "")).filter(Boolean))];
  let workspaceOwnerById = new Map();
  if (workspaceIds.length) {
    const result = await db.from("portal_workspaces").select("id,owner_user_id").in("id", workspaceIds);
    if (result.error) throw new Error("work_line_workspace_lookup_failed");
    workspaceOwnerById = new Map((result.data ?? []).map((row) => [String(row.id), String(row.owner_user_id)]));
  }
  const matches = data.filter((row) => {
    const provenOwner = workspaceOwnerById.get(String(row.workspace_id ?? "")) || String(row.manager_user_id ?? "");
    if (provenOwner !== String(owner)) return false;
    const from = postgresInstantMicros(row.provisioned_at ?? row.requested_at);
    const until = row.released_at == null ? null : postgresInstantMicros(row.released_at);
    return from !== null && instant >= from && (row.released_at == null || (until !== null && instant <= until));
  });
  return matches.length === 1 ? { id: String(matches[0].id), phone: String(matches[0].phone_number), owner: String(owner) } : null;
}

async function loadExisting(db, candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.event.ownerManagerUserId}\0${candidate.event.sourceNamespace}`;
    groups.set(key, groups.get(key) ?? { owner: candidate.event.ownerManagerUserId, namespace: candidate.event.sourceNamespace, ids: new Set() });
    groups.get(key).ids.add(candidate.event.sourceEventId);
  }
  const found = new Map();
  for (const group of groups.values()) {
    const ids = [...group.ids];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const { data, error } = await db.from("sms_projection_turns")
        .select("owner_manager_user_id,conversation_id,source_namespace,source_event_id,direction,body,occurred_at,from_phone,to_phone,source_ref")
        .eq("owner_manager_user_id", group.owner).eq("source_namespace", group.namespace)
        .in("source_event_id", ids.slice(offset, offset + 200));
      if (error) {
        console.error(JSON.stringify({ stage: "projection_inventory", code: error.code ?? "unknown" }));
        throw new Error("projection_inventory_failed");
      }
      const conversationIds = [...new Set((data ?? []).map((row) => String(row.conversation_id)))];
      let summaries = [];
      if (conversationIds.length) {
        const result = await db.from("sms_projection_conversations")
          .select("id,counterparty_role,work_line_id,identity_kind,identity_key,counterparty_user_id,counterparty_phone,metadata,event_count").in("id", conversationIds);
        if (result.error) throw new Error("projection_summary_inventory_failed");
        summaries = result.data ?? [];
      }
      const byConversation = new Map(summaries.map((row) => [String(row.id), row]));
      for (const row of data ?? []) {
        const summary = byConversation.get(String(row.conversation_id));
        if (!summary) throw new Error("projection_summary_inventory_missing");
        found.set(keyOf(row.owner_manager_user_id, row.source_namespace, row.source_event_id), {
          ...row, counterparty_role: summary.counterparty_role, work_line_id: summary.work_line_id,
          identity_kind: summary.identity_kind, identity_key: summary.identity_key,
          counterparty_user_id: summary.counterparty_user_id, counterparty_phone: summary.counterparty_phone,
          metadata: summary.metadata, event_count: summary.event_count,
        });
      }
    }
  }
  const providerGroups = new Map();
  for (const candidate of candidates) {
    if (!candidate.providerLookupId) continue;
    const owner = candidate.event.ownerManagerUserId;
    providerGroups.set(owner, providerGroups.get(owner) ?? new Set());
    providerGroups.get(owner).add(candidate.providerLookupId);
  }
  for (const [owner, ids] of providerGroups) {
    const sourceIds = [...ids];
    for (let offset = 0; offset < sourceIds.length; offset += 200) {
      const { data, error } = await db.from("sms_projection_turns")
        .select("owner_manager_user_id,conversation_id,provider_sid,direction,body,occurred_at,from_phone,to_phone,source_ref")
        .eq("owner_manager_user_id", owner).in("provider_sid", sourceIds.slice(offset, offset + 200));
      if (error) throw new Error("projection_provider_inventory_failed");
      const summaryIds = [...new Set((data ?? []).map((row) => String(row.conversation_id)))];
      const { data: summaries, error: summaryError } = summaryIds.length
        ? await db.from("sms_projection_conversations")
          .select("id,counterparty_role,work_line_id,identity_kind,identity_key,counterparty_user_id,counterparty_phone,metadata,event_count").in("id", summaryIds)
        : { data: [], error: null };
      if (summaryError) throw new Error("projection_provider_summary_failed");
      const bySummary = new Map((summaries ?? []).map((row) => [String(row.id), row]));
      for (const row of data ?? []) {
        const summary = bySummary.get(String(row.conversation_id));
        if (!summary) throw new Error("projection_provider_summary_missing");
        found.set(`provider\0${owner}\0${row.provider_sid}`, {
          ...row, counterparty_role: summary.counterparty_role, work_line_id: summary.work_line_id,
          identity_kind: summary.identity_kind, identity_key: summary.identity_key,
          counterparty_user_id: summary.counterparty_user_id, counterparty_phone: summary.counterparty_phone,
          metadata: summary.metadata, event_count: summary.event_count,
        });
      }
    }
  }
  return found;
}

async function maybeImportHistorical(db, table, sourceId) {
  const { data, error } = await db.rpc("import_sms_projection_historical_event", {
    p_source_table: table,
    p_source_id: String(sourceId),
  });
  if (error) {
    const missing = String(error.message ?? "").match(/null value in column "([^"]+)" of relation "([^"]+)"/i);
    console.error(JSON.stringify({ stage: "historical_import", table, code: error.code ?? "historical_import_failed",
      missingColumn: missing?.[1] ?? null, relation: missing?.[2] ?? null }));
    return { ok: false, code: error.code ?? "historical_import_failed" };
  }
  return { ok: true, data };
}

async function importRetainedHistorical(db, table, sourceId) {
  const { data, error } = await db.rpc("import_sms_retained_historical_source", {
    p_source_table: table, p_source_id: String(sourceId),
  });
  if (error || (data?.skipped !== "deleted" &&
      (data?.historicalSourcePreserved !== true || data?.historicalSourceMirrorAccounted !== true))) {
    throw new Error(`retained_source_import_failed_${String(error?.code ?? "invalid_result")}`);
  }
  return data;
}

async function candidateFromRow(db, kind, row, options = {}) {
  const owner = String(row.manager_user_id ?? "").trim();
  if (!owner) return { owner, event: null, sourceTable: kind, sourceId: String(row.id ?? row.source_message_id ?? "") };
  let role = String(row.counterparty_role ?? options.role ?? "unknown");
  if (!["prospect", "resident", "applicant", "vendor", "manager", "admin", "unknown"].includes(role)) role = "unknown";
  const direction = String(row.direction ?? options.direction ?? "inbound");
  const fromPhone = row.from_phone == null ? options.fromPhone ?? null : String(row.from_phone);
  const toPhone = row.to_phone == null ? options.toPhone ?? null : String(row.to_phone);
  const counterpartyPhone = String(row.counterparty_phone_e164 ?? row.resident_phone ?? (direction === "inbound" ? fromPhone : toPhone) ?? "").trim();
  const workPhone = String(options.workPhone ?? (direction === "inbound" ? toPhone : fromPhone) ?? "").trim();
  const occurredAt = String(row.received_at ?? row.first_received_at ?? row.created_at ?? "");
  const { sourceRowId, providerEventId, annotationEventId } = splitSourceIdentity(row, kind);
  const providerLookupId = providerEventId || annotationEventId;
  const sourceId = providerLookupId || sourceRowId;
  const isVoiceAnnotation = Boolean(annotationEventId);
  const hasSid = Boolean(providerEventId) && !isVoiceAnnotation;
  const identity = buildSmsIdentity({ role, userId: row.matched_sender_user_id ?? row.resident_user_id ?? null, phone: counterpartyPhone, sourceId });
  // The historical importer scopes an unplaced prospect to its source row.
  // Keep that exact identity when the phone evidence is absent; a provider
  // SID alone is not a counterparty and must not silently rename the row.
  if (kind === "prospect_sms_ingress" && identity.identityKind === "unresolved") {
    identity.identityKey = `unresolved:prospect_sms_ingress:${sourceRowId}`;
  }
  const line = await loadWorkLine(db, owner, workPhone, occurredAt);
  const eventOwner = line?.owner ?? owner;
  const namespace = isVoiceAnnotation ? sourceNamespace(eventOwner, annotationEventId, kind)
    : hasSid ? sourceNamespace(eventOwner, providerEventId, kind) : `legacy:${kind}:${eventOwner}`;
  const event = {
    ownerManagerUserId: eventOwner,
    counterpartyRole: role,
    workLineId: line?.id ?? "",
    identityKey: identity.identityKey,
    identityKind: identity.identityKind,
    counterpartyUserId: String(row.matched_sender_user_id ?? row.resident_user_id ?? "").trim() || null,
    counterpartyPhone: normalizeSmsPhone(counterpartyPhone) || null,
    legacyConversationKey: String(row.conversation_key ?? "").trim() || null,
    legacyThreadId: options.legacyThreadId ?? null,
    sourceNamespace: namespace,
    sourceEventId: sourceId,
    direction,
    body: String(row.body ?? ""),
    occurredAt,
    fromPhone,
    toPhone,
    sourceRef: { table: kind, id: sourceRowId, providerEventId: providerEventId || null,
      annotationEventId: annotationEventId || null, backfill: true },
    metadata: { ...(options.metadata ?? {}), ...(line ? {} : { sendDisabled: true }) },
  };
  return { owner: eventOwner, event, line, sourceTable: kind, sourceId: sourceRowId || sourceId,
    sourceRowId, providerEventId, annotationEventId, providerLookupId, namespace };
}

function validateEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const match = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  if (!match || match[1] !== DEV_PROJECT_REF) throw new Error("Refusing SMS projection reconciliation outside the dev/test Supabase project.");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function loadCursorState(path) {
  if (!path || !existsSync(path)) return { version: 2, cursors: {}, counts: {}, cleanPasses: 0 };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed?.version !== 2 || typeof parsed.cursors !== "object") throw new Error("Invalid SMS projection cursor file; rerun dry-run with a version 2 cursor.");
  return { version: 2, cursors: parsed.cursors ?? {}, counts: parsed.counts ?? {}, cleanPasses: Number(parsed.cleanPasses ?? 0), passComplete: Boolean(parsed.passComplete) };
}

function saveCursorState(path, state) {
  const absolute = resolve(path);
  const temp = `${absolute}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, absolute);
}

async function processCandidates(db, candidates, phaseCounts, { apply }) {
  const valid = candidates.filter((candidate) => candidate.event);
  const existing = await loadExisting(db, valid);
  for (const candidate of candidates) {
    phaseCounts.scanned += 1;
    if (!candidate.event) {
      addOwnerCount(phaseCounts, candidate.owner, "scanned");
      if (candidate.pendingClassification) {
        phaseCounts.unresolvedLine += 1;
        addOwnerCount(phaseCounts, candidate.owner, "pendingClassification");
        continue;
      }
      if (candidate.sourceTable === "legacy_sms_notice") {
        phaseCounts.unresolvedNotice += 1;
        addOwnerCount(phaseCounts, candidate.owner, "unresolvedNotice");
        continue;
      }
      if (candidate.sourceTable === "sms_relay_messages") {
        phaseCounts.historicalOnly += 1;
        addOwnerCount(phaseCounts, candidate.owner, "historicalOnly");
        if (!apply) phaseCounts.unresolvedRelay += 1;
        if (apply) {
          const imported = await maybeImportHistorical(db, candidate.sourceTable, candidate.sourceRowId ?? candidate.sourceId);
          if (!imported.ok) {
            phaseCounts.errors += 1;
            throw new Error(`Historical import failed for ${candidate.sourceTable} (${imported.code}). Cursor was not advanced.`);
          }
          phaseCounts.historicalImported += imported.data?.inserted === true ? 1 : 0;
        }
      }
      continue;
    }
    addOwnerCount(phaseCounts, candidate.owner, "scanned");
    const event = candidate.event;
    const prior = existing.get(keyOf(event.ownerManagerUserId, event.sourceNamespace, event.sourceEventId))
      ?? (candidate.providerLookupId ? existing.get(`provider\0${event.ownerManagerUserId}\0${candidate.providerLookupId}`) : null);
    if (candidate.retainedHistorical) {
      const proof = candidate.retainedHistorical;
      if (prior && (prior.owner_manager_user_id !== event.ownerManagerUserId ||
          prior.source_namespace !== event.sourceNamespace || prior.source_event_id !== event.sourceEventId ||
          prior.source_ref?.archiveReason !== "receipt_owner_conflict" ||
          prior.source_ref?.fingerprint !== proof.fingerprint ||
          prior.source_ref?.mirror?.id !== proof.mirrorId ||
          prior.metadata?.historical !== true || prior.metadata?.sendDisabled !== true ||
          prior.metadata?.archiveReason !== "receipt_owner_conflict" ||
          !eventMatchesStored(prior, event))) {
        phaseCounts.integrityMismatch += 1;
        throw new Error("retained_source_projection_conflict");
      }
      if (apply) {
        const result = await importRetainedHistorical(db, candidate.sourceTable, candidate.sourceRowId);
        if (result.skipped === "deleted") {
          phaseCounts.deletedEvents = (phaseCounts.deletedEvents ?? 0) + 1;
          addOwnerCount(phaseCounts, candidate.owner, "deletedEvents");
          continue;
        }
      }
      if (proof.isMirror) {
        phaseCounts.historicalSourceMirrorAccounted = (phaseCounts.historicalSourceMirrorAccounted ?? 0) + 1;
        addOwnerCount(phaseCounts, candidate.owner, "historicalSourceMirrorAccounted");
      } else {
        phaseCounts.historicalSourcePreserved = (phaseCounts.historicalSourcePreserved ?? 0) + 1;
        addOwnerCount(phaseCounts, candidate.owner, "historicalSourcePreserved");
      }
      continue;
    }
    if (prior) {
      const historicalLine = !candidate.line && prior.source_ref?.historical === true &&
        prior.source_ref?.table === candidate.sourceTable;
      const placeholderEnriched = prior.source_ref?.historical === true
        && ["unresolved", "phone"].includes(prior.identity_kind)
        && (prior.counterparty_role === "unknown" || prior.counterparty_role === event.counterpartyRole)
        && event.identityKind === "user" && Boolean(event.counterpartyUserId)
        && eventMatchesStored(prior, event, { historicalLine: true, allowIdentityEnrichment: true, allowRoleEnrichment: true });
      const derivedAutomatedMirror = candidate.sourceTable === "manager_sms_messages" &&
        candidate.sourceSubtype === "automated" && event.direction === "inbound" &&
        ["inbound_sms_log", "sms_inbound_receipts", "prospect_sms_ingress"].includes(String(prior.source_ref?.table ?? "")) &&
        prior.body !== event.body && eventMatchesStored(prior, { ...event, body: prior.body }, { historicalLine });
      const exactInboundMirror = isExactInboundMirrorOfOriginal(prior, event, candidate, { historicalLine });
      if (eventMatchesStored(prior, event, { historicalLine }) || placeholderEnriched || derivedAutomatedMirror || exactInboundMirror) {
        if (placeholderEnriched && !candidate.line) {
          // This exact historical singleton remains read-only until an owned
          // work-line epoch is proven. Its original bytes and synthetic line
          // are retained; stronger current directory identity is not grafted
          // onto a transport event with no line proof.
          if (retainedHistoricalUnplacedIdentity(prior, event, candidate)) {
            phaseCounts.retainedUnresolved = (phaseCounts.retainedUnresolved ?? 0) + 1;
            addOwnerCount(phaseCounts, candidate.owner, "historical_line_unproven");
          } else {
            phaseCounts.integrityMismatch += 1;
            addOwnerCount(phaseCounts, candidate.owner, "historical_identity_retention_unproven");
          }
          continue;
        }
        if (placeholderEnriched && apply) {
          const { data, error } = await db.rpc("project_sms_conversation_event", { p_event: event });
          if (error) {
            phaseCounts.errors += 1;
            console.error(JSON.stringify({ stage: "historical_identity_reconcile", source: candidate.sourceTable,
              code: error.code ?? "unknown", priorRole: prior.counterparty_role, priorKind: prior.identity_kind,
              eventRole: event.counterpartyRole, eventKind: event.identityKind,
              hasLine: Boolean(candidate.line), historicalLine }));
            throw new Error(`Historical identity reconciliation failed (${error.code ?? "unknown"}). Cursor was not advanced.`);
          }
          if (data?.skipped === "deleted") {
            phaseCounts.deletedEvents = (phaseCounts.deletedEvents ?? 0) + 1;
            addOwnerCount(phaseCounts, candidate.owner, "deletedEvents");
          } else {
            phaseCounts.projected += data?.inserted === true ? 1 : 0;
            phaseCounts.enrichedPlaceholder += data?.inserted === false ? 1 : 0;
            addOwnerCount(phaseCounts, candidate.owner, "enrichedPlaceholder");
          }
        } else {
          phaseCounts.alreadyMapped += 1;
          if (placeholderEnriched) phaseCounts.enrichedPlaceholder += 1;
          if (derivedAutomatedMirror || exactInboundMirror) phaseCounts.derivedMirror += 1;
          addOwnerCount(phaseCounts, candidate.owner, "alreadyMapped");
        }
      } else {
        console.error(JSON.stringify({ stage: "projection_mismatch", source: candidate.sourceTable,
          fields: {
            body: prior.body === event.body, direction: prior.direction === event.direction,
            time: samePostgresInstant(prior.occurred_at, event.occurredAt),
            from: prior.from_phone === (event.fromPhone ?? null), to: prior.to_phone === (event.toPhone ?? null),
            owner: String(prior.owner_manager_user_id) === String(event.ownerManagerUserId),
            role: String(prior.counterparty_role) === String(event.counterpartyRole),
            line: historicalLine || String(prior.work_line_id) === String(event.workLineId),
            identityKind: String(prior.identity_kind) === String(event.identityKind),
            identityKey: String(prior.identity_key) === String(event.identityKey),
            counterpartyUser: String(prior.counterparty_user_id ?? "") === String(event.counterpartyUserId ?? ""),
          } }));
        // Earlier source precedence wins; never overwrite the stored event.
        phaseCounts.sourcePreferred += 1;
        phaseCounts.integrityMismatch += 1;
        addOwnerCount(phaseCounts, candidate.owner, "sourcePreferredIntegrityMismatch");
      }
      continue;
    }
    if (!candidate.line) {
      if (candidate.deferredToTransport) {
        phaseCounts.deferredToTransport += 1;
        addOwnerCount(phaseCounts, candidate.owner, "deferredToTransport");
        continue;
      }
      phaseCounts.historicalOnly += 1;
      addOwnerCount(phaseCounts, candidate.owner, "historicalOnly");
      if (!apply || !["prospect_sms_ingress", "inbound_sms_log", "manager_sms_messages"].includes(candidate.sourceTable)) {
        phaseCounts.unresolvedLine += 1;
        addOwnerCount(phaseCounts, candidate.owner, "unresolvedLine");
      }
      if (apply && ["prospect_sms_ingress", "inbound_sms_log", "manager_sms_messages"].includes(candidate.sourceTable)) {
        const imported = await maybeImportHistorical(db, candidate.sourceTable, candidate.sourceRowId ?? candidate.sourceId);
        if (!imported.ok) {
          phaseCounts.errors += 1;
          throw new Error(`Historical import failed for ${candidate.sourceTable} (${imported.code}). Cursor was not advanced.`);
        }
        phaseCounts.historicalImported += imported.data?.inserted === true ? 1 : 0;
      }
      continue;
    }
    phaseCounts.projectable += 1;
    addOwnerCount(phaseCounts, candidate.owner, "projectable");
    if (!apply) continue;
    const { data, error } = await db.rpc("project_sms_conversation_event", { p_event: event });
    if (error) {
      phaseCounts.errors += 1;
      const constraint = String(error.message ?? "").match(/unique constraint "([^"]+)"/i);
      console.error(JSON.stringify({ stage: "projection_rpc", source: candidate.sourceTable, code: error.code ?? "unknown",
        constraint: constraint?.[1] ?? null }));
      throw new Error(`Projection RPC failed (${error.code ?? "unknown"}). Cursor was not advanced.`);
    }
    phaseCounts.projected += data?.inserted === true ? 1 : 0;
    phaseCounts.alreadyMapped += data?.inserted === false ? 1 : 0;
  }
}

async function runFeed(db, state, feed, opts) {
  const counts = state.counts[feed.name] ?? emptyCounts();
  const cursor = state.cursors[feed.name] ?? null;
  let next = cursor;
  let pages = 0;
  let hasMore = false;
  while (pages < opts.maxPages) {
    let query = feed.query(db).order(feed.timestampColumn, { ascending: true }).order(feed.idColumn, { ascending: true }).limit(opts.batchSize);
    query = applyCursor(query, next, feed.timestampColumn, feed.idColumn);
    const { data, error } = await query;
    if (error) throw new Error(`Could not scan ${feed.name} (${error.code ?? "query_error"}).`);
    const rows = data ?? [];
    if (!rows.length) { hasMore = false; break; }
    const candidates = await feed.build(db, rows, counts, opts);
    await processCandidates(db, candidates, counts, { apply: opts.apply });
    next = cursorAfter(rows.at(-1), feed.timestampColumn, feed.idColumn);
    pages += 1;
    state.counts[feed.name] = counts;
    if (opts.apply) {
      state.cursors[feed.name] = next;
      saveCursorState(opts.cursorFile, state);
    }
    hasMore = rows.length === opts.batchSize;
    if (!hasMore) break;
  }
  state.counts[feed.name] = counts;
  if (!opts.apply) state.cursors[feed.name] = next;
  return { counts, pages, hasMore, cursor: next };
}

function feedConfigs() {
  return [
    {
      name: "prospect_sms_ingress", timestampColumn: "received_at", idColumn: "source_message_id",
      query: (db) => db.from("prospect_sms_ingress").select("source_message_id,manager_user_id,channel,body,received_at,burst_id,burst_revision"),
      build: async (db, rows) => {
        const burstIds = [...new Set(rows.map((row) => String(row.burst_id)))];
        const { data: bursts, error } = await db.from("prospect_sms_bursts")
          .select("id,manager_user_id,counterparty_phone_e164,reply_from_number,counterparty_role,channel")
          .in("id", burstIds);
        if (error) throw new Error("prospect_ingress_context_unavailable");
        const byId = new Map((bursts ?? []).map((burst) => [String(burst.id), burst]));
        const originals = await mapBounded(rows, MAX_ORIGINAL_RPC_CONCURRENCY, (row) =>
          row.channel === "twilio"
            ? resolveInboundOriginal(db, String(row.source_message_id), String(row.manager_user_id)) : null);
        const candidates = [];
        for (const [index, row] of rows.entries()) {
          const burst = byId.get(String(row.burst_id));
          if (!burst || burst.manager_user_id !== row.manager_user_id) throw new Error("prospect_ingress_burst_conflict");
          const original = originals[index];
          if (original && (!original.ingress || original.role !== "prospect" ||
              original.fromPhone !== burst.counterparty_phone_e164 || original.toPhone !== burst.reply_from_number)) {
            throw new Error("prospect_ingress_original_conflict");
          }
          const candidate = await candidateFromRow(db, "prospect_sms_ingress", {
            ...row, body: original?.body ?? row.body, received_at: original?.occurredAt ?? row.received_at,
            manager_user_id: row.manager_user_id, counterparty_role: "prospect",
            counterparty_phone_e164: burst.counterparty_phone_e164,
          }, { workPhone: original?.toPhone ?? burst.reply_from_number, fromPhone: original?.fromPhone ?? burst.counterparty_phone_e164,
            toPhone: original?.toPhone ?? burst.reply_from_number, direction: "inbound", metadata: { channel: row.channel, burstRevision: row.burst_revision } });
          if (original?.workLineId && candidate.line?.id !== original.workLineId) throw new Error("prospect_ingress_work_line_conflict");
          if (row.channel !== "twilio") candidate.line = null;
          candidates.push(candidate);
        }
        return candidates;
      },
    },
    {
      name: "sms_inbound_receipts", timestampColumn: "first_received_at", idColumn: "message_sid",
      // A cleared completed receipt is metadata, not original transcript evidence.
      // Its durable original is inventoried through ingress and transport logs.
      query: (db) => db.from("sms_inbound_receipts")
        .select("message_sid,manager_user_id,status,first_received_at")
        .not("inbound_payload", "is", null),
      build: async (db, rows) => {
        const sids = rows.map((row) => String(row.message_sid));
        const [{ data: logs, error }, { data: ingressRows, error: ingressError }] = await Promise.all([
          db.from("inbound_sms_log").select("manager_user_id,message_sid,counterparty_role,matched_sender_user_id,conversation_key").in("message_sid", sids),
          db.from("prospect_sms_ingress").select("source_message_id,manager_user_id").in("source_message_id", sids),
        ]);
        if (error) throw new Error("receipt_identity_evidence_unavailable");
        if (ingressError) throw new Error("receipt_ingress_evidence_unavailable");
        const logBySid = new Map((logs ?? []).map((row) => [`${row.manager_user_id}\0${row.message_sid}`, row]));
        const ingressKeys = new Set((ingressRows ?? []).map((row) => String(row.source_message_id)));
        const candidates = [];
        for (const row of rows) {
          const evidence = logBySid.get(`${row.manager_user_id}\0${row.message_sid}`) ?? {};
          if (row.status !== "completed" && (!evidence.counterparty_role || evidence.counterparty_role === "unknown") &&
              !ingressKeys.has(String(row.message_sid))) {
            candidates.push({ owner: String(row.manager_user_id), event: null, sourceTable: "sms_inbound_receipts",
              sourceId: String(row.message_sid), pendingClassification: true });
            continue;
          }
          const expectedOwner = (ingressRows ?? []).find((ingress) => ingress.source_message_id === row.message_sid)?.manager_user_id ?? row.manager_user_id;
          const original = await resolveInboundOriginal(db, String(row.message_sid), String(expectedOwner));
          const source = { ...row, body: original.body, manager_user_id: original.owner,
            message_sid: row.message_sid, counterparty_role: original.role,
            matched_sender_user_id: original.userId,
            conversation_key: original.conversationKey,
            created_at: original.occurredAt };
          const candidate = await candidateFromRow(db, "sms_inbound_receipts", source, {
            workPhone: original.toPhone, direction: "inbound", fromPhone: original.fromPhone, toPhone: original.toPhone,
            metadata: { receivedTimeSource: "receipt_first_received_at" },
          });
          if (original.workLineId && candidate.line?.id !== original.workLineId) throw new Error("receipt_work_line_conflict");
          candidate.deferredToTransport = Boolean(evidence.message_sid || ingressKeys.has(String(row.message_sid)));
          candidates.push(candidate);
        }
        return candidates;
      },
    },
    {
      name: "inbound_sms_log", timestampColumn: "created_at", idColumn: "id",
      query: (db) => db.from("inbound_sms_log").select("id,manager_user_id,from_phone,to_phone,matched_sender_user_id,body,message_sid,created_at,counterparty_role,conversation_key")
        .not("manager_user_id", "is", null),
      build: async (db, rows) => {
        const sids = [...new Set(rows.map((row) => String(row.message_sid ?? "")).filter(Boolean))];
        const [{ data: receipts, error }, { data: ingressRows, error: ingressError }] = await Promise.all([
          sids.length ? db.from("sms_inbound_receipts").select("message_sid,manager_user_id,status").in("message_sid", sids)
            : Promise.resolve({ data: [], error: null }),
          sids.length ? db.from("prospect_sms_ingress").select("source_message_id,manager_user_id,channel").in("source_message_id", sids)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (error) throw new Error("log_receipt_inventory_unavailable");
        if (ingressError) throw new Error("log_ingress_inventory_unavailable");
        const receiptBySid = new Map((receipts ?? []).map((row) => [String(row.message_sid), row]));
        const receiptSids = new Set(receiptBySid.keys());
        const ingressSids = new Set((ingressRows ?? []).map((row) => String(row.source_message_id)));
        const ingressBySid = new Map();
        for (const ingress of ingressRows ?? []) {
          if (ingress.channel !== "twilio") continue;
          const sid = String(ingress.source_message_id);
          if (ingressBySid.has(sid)) throw new Error("log_ingress_ambiguous");
          ingressBySid.set(sid, String(ingress.manager_user_id));
        }
        return mapBounded(rows, MAX_ORIGINAL_RPC_CONCURRENCY, async (row) => {
          const sid = String(row.message_sid ?? "");
          const receipt = receiptBySid.get(sid);
          if (receipt?.status === "completed" && receipt.manager_user_id &&
              receipt.manager_user_id !== row.manager_user_id && !ingressSids.has(sid)) {
            const retained = await resolveRetainedHistoricalSource(db, "inbound_sms_log", row.id);
            if (retained) return retainedHistoricalCandidate(retained, "inbound_sms_log", row);
          }
          const expectedOwner = ingressBySid.get(sid) ?? String(row.manager_user_id);
          const original = receiptSids.has(sid)
            ? await resolveInboundOriginal(db, sid, expectedOwner) : null;
          if (original && original.receiptOwner !== row.manager_user_id) throw new Error("log_receipt_holder_conflict");
          const source = original ? { ...row, manager_user_id: original.owner,
            body: original.body, from_phone: original.fromPhone,
            to_phone: original.toPhone, created_at: original.occurredAt,
            counterparty_role: original.role, matched_sender_user_id: original.userId,
            conversation_key: original.owner === original.receiptOwner ? row.conversation_key : null } : row;
          const candidate = await candidateFromRow(db, "inbound_sms_log", source, { workPhone: source.to_phone, direction: "inbound" });
          if (original?.workLineId && candidate.line?.id !== original.workLineId) throw new Error("log_work_line_conflict");
          return candidate;
        });
      },
    },
    {
      name: "manager_sms_messages", timestampColumn: "created_at", idColumn: "id",
      query: (db) => db.from("manager_sms_messages").select("id,manager_user_id,resident_user_id,resident_phone,direction,body,from_phone,to_phone,message_sid,source,created_at,counterparty_role,conversation_key"),
      build: async (db, rows) => {
        const inboundSids = [...new Set(rows.filter((row) => row.direction === "inbound")
          .map((row) => String(row.message_sid ?? "")).filter(Boolean))];
        const [{ data: receipts, error: receiptError }, { data: ingressRows, error: ingressError }] = await Promise.all([
          inboundSids.length ? db.from("sms_inbound_receipts").select("message_sid,manager_user_id,status").in("message_sid", inboundSids)
            : Promise.resolve({ data: [], error: null }),
          inboundSids.length ? db.from("prospect_sms_ingress")
            .select("source_message_id,manager_user_id,channel").in("source_message_id", inboundSids)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (receiptError || ingressError) throw new Error("manager_log_receipt_inventory_unavailable");
        const receiptBySid = new Map((receipts ?? []).map((receipt) => [String(receipt.message_sid), receipt]));
        const receiptSids = new Set(receiptBySid.keys());
        const ingressSids = new Set((ingressRows ?? []).map((row) => String(row.source_message_id)));
        const ingressBySid = new Map();
        for (const ingress of ingressRows ?? []) {
          if (ingress.channel !== "twilio") continue;
          const sid = String(ingress.source_message_id);
          if (ingressBySid.has(sid)) throw new Error("manager_log_ingress_ambiguous");
          ingressBySid.set(sid, String(ingress.manager_user_id));
        }
        return mapBounded(rows, MAX_ORIGINAL_RPC_CONCURRENCY, async (row) => {
          const sid = String(row.message_sid ?? "");
          const receipt = receiptBySid.get(sid);
          if (row.direction === "inbound" && receiptSids.has(sid)) {
            if (receipt.status === "completed" && receipt.manager_user_id &&
                receipt.manager_user_id !== row.manager_user_id && !ingressSids.has(sid)) {
            const retained = await resolveRetainedHistoricalSource(db, "manager_sms_messages", row.id);
            if (retained) return retainedHistoricalCandidate(retained, "manager_sms_messages", row);
            }
            await resolveInboundOriginal(db, sid, ingressBySid.get(sid) ?? String(row.manager_user_id));
          }
          return { ...await candidateFromRow(db, "manager_sms_messages", row, {
            workPhone: row.direction === "inbound" ? row.to_phone : row.from_phone,
            direction: row.direction === "inbound" ? "inbound" : "outbound",
          }), sourceSubtype: row.source };
        });
      },
    },
    {
      name: "sms_relay_messages", timestampColumn: "created_at", idColumn: "id",
      query: (db) => db.from("sms_relay_messages").select("id,manager_user_id,thread_id,twilio_sid,sender_role,body,created_at"),
      build: async (_db, rows) => rows.map((row) => ({ owner: String(row.manager_user_id), event: null, sourceTable: "sms_relay_messages", sourceId: String(row.id) })),
    },
    {
      name: "legacy_sms_notices", timestampColumn: "updated_at", idColumn: "id",
      query: (db) => db.from("portal_inbox_thread_records").select("id,scope,owner_user_id,thread_type,row_data,updated_at")
        .eq("scope", NOTICE_SCOPE),
      build: async (db, rows, counts, opts) => {
        const allMarkers = rows.flatMap((row) => {
          const payload = row.row_data && typeof row.row_data === "object" ? row.row_data : {};
          const messages = Array.isArray(payload.messages) ? payload.messages : [];
          return [payload.rootOriginalSmsEvent, ...messages.map((message) => message?.originalSmsEvent)]
            .filter(isProjectionNoticeMarker);
        });
        const ids = [...new Set(allMarkers.map((marker) => marker.sourceEventId))];
        const [{ data: turns, error: turnError }, { data: deleted, error: deletedError }] = await Promise.all([
          ids.length ? db.from("sms_projection_turns")
            .select("owner_manager_user_id,source_namespace,source_event_id,conversation_id,body,occurred_at")
            .in("source_event_id", ids) : Promise.resolve({ data: [], error: null }),
          ids.length ? db.from("sms_projection_deleted_events")
            .select("owner_manager_user_id,source_namespace,source_event_id")
            .in("source_event_id", ids) : Promise.resolve({ data: [], error: null }),
        ]);
        if (turnError || deletedError) throw new Error("notice_projection_inventory_failed");
        const summaryIds = [...new Set((turns ?? []).map((turn) => String(turn.conversation_id)))];
        const { data: summaries, error: summaryError } = summaryIds.length
          ? await db.from("sms_projection_conversations").select("id,counterparty_role,work_line_id").in("id", summaryIds)
          : { data: [], error: null };
        if (summaryError) throw new Error("notice_summary_inventory_failed");
        const bySummary = new Map((summaries ?? []).map((summary) => [String(summary.id), summary]));
        const isBound = (marker) => (turns ?? []).some((turn) => {
          const summary = bySummary.get(String(turn.conversation_id));
          return turn.owner_manager_user_id === marker.ownerManagerUserId &&
            turn.source_namespace === marker.sourceNamespace && turn.source_event_id === marker.sourceEventId &&
            summary?.counterparty_role === marker.counterpartyRole && summary?.work_line_id === marker.workLineId &&
            samePostgresInstant(turn.occurred_at, marker.occurredAt) &&
            createHash("sha256").update(String(turn.body ?? "")).digest("hex") === marker.bodySha256;
        }) || (deleted ?? []).some((event) => event.owner_manager_user_id === marker.ownerManagerUserId &&
          event.source_namespace === marker.sourceNamespace && event.source_event_id === marker.sourceEventId);
        const boundTurnForMarker = (marker) => (turns ?? []).find((turn) => {
          const summary = bySummary.get(String(turn.conversation_id));
          const exact = turn.owner_manager_user_id === marker.ownerManagerUserId &&
            turn.source_namespace === marker.sourceNamespace && turn.source_event_id === marker.sourceEventId &&
            summary?.counterparty_role === marker.counterpartyRole && summary?.work_line_id === marker.workLineId &&
            samePostgresInstant(turn.occurred_at, marker.occurredAt) &&
            createHash("sha256").update(String(turn.body ?? "")).digest("hex") === marker.bodySha256;
          return exact;
        });
        const boundConversationIds = (marker) => {
          const turn = boundTurnForMarker(marker);
          return turn ? [String(turn.conversation_id)] : [];
        };
        const candidates = [];
        for (const row of rows) {
          const payload = row.row_data && typeof row.row_data === "object" ? row.row_data : {};
          const smsNotice = ["claw_resident_sms", "claw_leasing_sms", "sms_relay"].includes(String(row.thread_type ?? payload.threadType ?? ""))
            || /^(claw_resident_|claw_lease_|sms_relay_|sms_notice_)/.test(String(row.id));
          if (!smsNotice) continue;
          const messages = Array.isArray(payload.messages) ? payload.messages : [];
          const originals = [
            ...(Array.isArray(payload.smsOriginalEvents) ? payload.smsOriginalEvents : []),
            ...(payload.rootOriginalSmsEvent ? [payload.rootOriginalSmsEvent] : []),
            ...messages.flatMap((message) => message?.originalSmsEvent ? [message.originalSmsEvent] : []),
          ];
          const marked = originals.filter((item) => isExplicitNoticeOriginal(item) || isProjectionNoticeMarker(item));
          const unbound = marked.filter((item) => !isProjectionNoticeMarker(item) || !isBound(item));
          const malformed = originals.length - marked.length;
          counts.explicitNoticeMarkers += marked.length;
          if (marked.length) addOwnerCount(counts, row.owner_user_id, "explicitNoticeMarkers", marked.length);
          if (unbound.length) {
            counts.unboundOriginalMarkers = (counts.unboundOriginalMarkers ?? 0) + unbound.length;
            addOwnerCount(counts, row.owner_user_id, "unboundOriginalMarkers", unbound.length);
          }
          if (malformed) {
            counts.malformedOriginalMarkers = (counts.malformedOriginalMarkers ?? 0) + malformed;
            addOwnerCount(counts, row.owner_user_id, "malformedOriginalMarkers", malformed);
          }
          const projectionMarkers = marked.filter(isProjectionNoticeMarker);
          const exactSingleTarget = shouldBindLegacyThreadAlias({
            markedCount: marked.length,
            projectionMarkerCount: projectionMarkers.length,
            messages,
            allMarkersBound: projectionMarkers.every(isBound),
            conversationIds: projectionMarkers.flatMap(boundConversationIds),
          });
          if (exactSingleTarget && opts.apply) {
            const targetId = boundConversationIds(projectionMarkers[0])[0];
            const exactTurn = boundTurnForMarker(projectionMarkers[0]);
            const { data, error } = await db.rpc("bind_sms_projection_legacy_thread_alias", {
              p_owner: row.owner_user_id,
              p_conversation: targetId,
              p_legacy_thread: String(row.id),
              p_source_namespace: projectionMarkers[0].sourceNamespace,
              p_source_event_id: projectionMarkers[0].sourceEventId,
              p_counterparty_role: projectionMarkers[0].counterpartyRole,
              p_work_line_id: projectionMarkers[0].workLineId,
              p_occurred_at: projectionMarkers[0].occurredAt,
              p_body: exactTurn.body,
            });
            if (error) throw new Error("legacy_sms_thread_alias_bind_failed");
            if (data === true || data?.bound === true) {
              counts.legacyThreadAliasesBound = (counts.legacyThreadAliasesBound ?? 0) + 1;
              addOwnerCount(counts, row.owner_user_id, "legacyThreadAliasesBound");
            }
          }
          // Current notice rows are mirror/annotation payloads. Only a future
          // explicit original-event array is eligible, never split `body` or
          // newline-delimited `messages` from a generated manager brief.
          if (unbound.length || malformed) candidates.push({ owner: String(row.owner_user_id), event: null, sourceTable: "legacy_sms_notice", sourceId: String(row.id) });
          else {
            counts.legacyNoticeVisible = (counts.legacyNoticeVisible ?? 0) + 1;
            addOwnerCount(counts, row.owner_user_id, "legacyNoticeVisible");
          }
        }
        return candidates;
      },
    },
  ];
}

export async function runBackfill(db, options) {
  const state = loadCursorState(options.cursorFile);
  if (options.apply && state.passComplete) {
    // A second full pass over the immutable source inventory proves replay
    // idempotence before this tool can publish cutover readiness.
    state.cursors = {};
    state.counts = {};
    state.passComplete = false;
  }
  if (options.apply) {
    const { error } = await db.from("sms_projection_cutover")
      .update({ ready: false, updated_at: new Date().toISOString() }).eq("singleton", true);
    if (error) throw new Error("cutover_readiness_reset_failed");
  }
  const results = [];
  for (const feed of feedConfigs()) {
    // Feed order encodes source authority. Never let a bounded page cap move
    // reconciliation to a lower-priority mirror while originals remain.
    if (!feedMayRunAfter(results)) {
      results.push({ source: feed.name, pages: 0, hasMore: true, blockedByPrecedence: true,
        counts: state.counts[feed.name] ?? emptyCounts(), cursor: state.cursors[feed.name] ?? null });
      continue;
    }
    const result = await runFeed(db, state, feed, options);
    results.push({ source: feed.name, pages: result.pages, hasMore: result.hasMore, counts: result.counts, cursor: result.cursor });
  }
  const inventoryComplete = results.every((result) => !result.hasMore);
  const clean = inventoryComplete && isCleanCutoverInventory(results);
  if (options.apply && clean) {
    state.cleanPasses = Math.min(2, Number(state.cleanPasses ?? 0) + 1);
    state.passComplete = true;
  }
  if (options.apply && inventoryComplete && !clean) {
    // Start a fresh complete inventory next time so repaired source evidence
    // can clear old unresolved dispositions instead of inheriting them forever.
    state.cursors = {};
    state.counts = {};
    state.cleanPasses = 0;
    state.passComplete = false;
  }
  if (options.apply) saveCursorState(options.cursorFile, state);
  const complete = options.apply && clean && state.cleanPasses >= 2;
  let readinessUpdated = false;
  if (options.apply && complete) {
    const { error } = await db.from("sms_projection_cutover")
      .update({ ready: true, updated_at: new Date().toISOString() }).eq("singleton", true);
    if (error) throw new Error("cutover_readiness_update_failed");
    readinessUpdated = true;
  }
  const readyForApply = clean;
  return { mode: options.apply ? "apply" : "dry-run", complete, inventoryComplete, readyForApply, readinessUpdated, cleanPasses: state.cleanPasses ?? 0, sources: results };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Dry-run: node scripts/backfill-sms-projection.mjs [--batch-size 100] [--max-pages 10] [--cursor-file PATH]\nApply:   node scripts/backfill-sms-projection.mjs --apply --cursor-file PATH");
    return;
  }
  const db = validateEnv();
  const report = await runBackfill(db, options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.complete) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = String(error?.message ?? "sms_projection_backfill_failed").split(/[(:]/, 1)[0].replace(/[^a-z0-9_-]/gi, "_");
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  });
}
